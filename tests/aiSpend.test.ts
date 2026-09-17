import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { firmSpend } from "../src/worker/ai/spend";
import { acceptQuarantinedOutput, discardQuarantinedOutput } from "../src/worker/services/aiRuns";
import { runHealthChecks } from "../src/worker/services/health";
import { SPEND_POSTURES, postureFor } from "../src/shared/ai/spendPosture";

/**
 * Item 21 — the Cockpit overhaul. Three defects the operator found on the deployed system, and one
 * test each for the thing that was actually wrong rather than for the code that replaced it.
 *
 *   1. "Best available" wrote a policy identical to "Balanced" — two choices, one behaviour.
 *   2. Spend had three definitions that disagreed by 28% under the same word.
 *   3. 51 quarantined outputs could not be accepted, because the button did not exist.
 *
 * Plus item 23: a firmwide budget that persists and BINDS. The failure worth testing there is not
 * that a number saves — it is that a saved number refuses a run.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_pierce", roles: [], firmScopes: ["west-peek"] };

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

/** A provider response with a stated cost, so "actual" and "estimate" can be told apart. */
function stubFetch(text = "stubbed output", costUsd: number | null = 0.001): typeof fetch {
  return (async () =>
    new Response(
      // One body carrying every wire shape the adapters now speak — see tests/ai.test.ts for why.
      JSON.stringify({
        text,
        model: "stub-model",
        choices: [{ message: { content: text } }],
        content: [{ type: "text", text }],
        candidates: [{ content: { parts: [{ text }] } }],
        // Gemini reports usage under its own name. Without it the adapter reports zero tokens and
        // the run is priced at zero, which is how "spent today" once stayed permanently at $0.
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
        usage:
          costUsd === null
            ? { input_tokens: 10, output_tokens: 20, prompt_tokens: 10, completion_tokens: 20 }
            : { input_tokens: 10, output_tokens: 20, cost_usd: costUsd, prompt_tokens: 10, completion_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

async function setPolicy(over: Partial<{ cost_mode: string; privacy_mode: string; daily_cap_usd: number; per_run_cap_usd: number; honours_pins: number; prefers_frontier: number }> = {}): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, set_by)
       VALUES (?1, 'west-peek', ?2, ?3, ?4, ?5, ?6, ?7, 'fu_scooter_taylor')`,
    )
    .bind(
      `bp_${crypto.randomUUID()}`,
      over.cost_mode ?? "NORMAL",
      over.privacy_mode ?? "FRONTIER",
      over.daily_cap_usd ?? 1000,
      over.per_run_cap_usd ?? 1000,
      over.honours_pins ?? 1,
      over.prefers_frontier ?? 0,
    )
    .run();
}

/** Enable one provider and let PUBLIC egress to it. Everything else stays default-deny. */
async function enableProvider(providerId: string): Promise<void> {
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
    .prepare("INSERT OR REPLACE INTO provider_data_policy (id, provider_id, privacy_label, allowed) VALUES (?1, ?2, 'PUBLIC', 1)")
    .bind(`pdp_${providerId}_PUBLIC`, providerId)
    .run();
}

function run(overrides: Partial<Parameters<typeof runAi>[1]> = {}, deps: Parameters<typeof runAi>[2] = {}) {
  return runAi(
    env,
    { purpose: "cockpit spend test", actor: MP_ACTOR, inputs: ["an ordinary input"], sensitivity: "PUBLIC", ...overrides },
    deps,
  );
}

beforeAll(async () => {
  t = await createTestDb();
  /*
   * THE DIRECT-VENDOR ADAPTERS FAIL CLOSED, which the old generic one did not.
   *
   * `httpExternal` sent its request with no authorization header when no key was set, so a stubbed
   * fetch answered and the run "succeeded" without a credential. The real vendors do not work that
   * way, and since these adapters speak their actual wire contracts they throw
   * `credential_missing:<vendor>` before any network attempt — the same contract OpenRouter and
   * Fireworks have always had. A suite that expects a vendor call to complete therefore has to
   * configure that vendor, which is the honest precondition.
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

// ── 1. Two postures that were one policy ──

describe("the spend lever has four settings and four behaviours", () => {
  it("gives every posture a distinct stored policy — the defect was two of them being identical", () => {
    const signatures = SPEND_POSTURES.map((p) => `${p.costMode}|${p.honoursPins}|${p.prefersFrontier}`);
    expect(new Set(signatures).size).toBe(SPEND_POSTURES.length);
  });

  it("reads every stored policy back as the posture that wrote it", () => {
    // The visible half of the same bug: choosing "Best available" showed "Balanced" as current,
    // because the two were indistinguishable once written.
    for (const p of SPEND_POSTURES) {
      expect(postureFor(p.costMode, p.honoursPins, p.prefersFrontier), p.key).toBe(p.key);
    }
  });

  it("sends unpinned work to the dearest model under 'best available' and the cheapest under 'balanced'", async () => {
    await enableProvider("prov_openai");
    await enableProvider("prov_google");

    await setPolicy({ prefers_frontier: 0 });
    const balanced = await run({}, { fetchImpl: stubFetch() });
    const balancedRouting = await t.db
      .prepare("SELECT selected_model, explanation FROM ai_run_routing WHERE ai_run_id = ?1")
      .bind(balanced.run.id)
      .first<{ selected_model: string; explanation: string }>();

    await setPolicy({ prefers_frontier: 1 });
    const best = await run({}, { fetchImpl: stubFetch() });
    const bestRouting = await t.db
      .prepare("SELECT selected_model, explanation FROM ai_run_routing WHERE ai_run_id = ?1")
      .bind(best.run.id)
      .first<{ selected_model: string; explanation: string }>();

    // The whole point: the two postures now choose differently.
    expect(bestRouting?.selected_model).not.toBe(balancedRouting?.selected_model);
    expect(bestRouting?.explanation).toContain("best available");
    // And the run says WHY, including the honest caveat that price is standing in for quality.
    expect(bestRouting?.explanation).toContain("proxy");
  });
});

// ── 2. One definition of spend ──

describe("spend has exactly one definition", () => {
  it("counts a committed run once, the same way, in today / this month / all time", async () => {
    await enableProvider("prov_openai");
    await setPolicy();
    await run({}, { fetchImpl: stubFetch("priced", 0.004) });

    const today = await firmSpend(env, "west-peek", "TODAY");
    const month = await firmSpend(env, "west-peek", "THIS_MONTH");
    const ever = await firmSpend(env, "west-peek", "ALL_TIME");

    // A run made in this test is inside all three windows, so all three must agree. They did not:
    // the diagnostics figure ignored estimates and the all-time figure ignored them too, while the
    // daily figure counted them — which is where the operator's 28% came from.
    expect(today.total_usd).toBe(month.total_usd);
    expect(month.total_usd).toBe(ever.total_usd);
    expect(ever.total_usd).toBeGreaterThan(0);
  });

  it("counts an estimate-only run as its estimate, not as free", async () => {
    const before = await firmSpend(env, "west-peek", "ALL_TIME");
    // A provider that reports usage without a price. The old all-time query dropped this run
    // entirely; the old diagnostics query valued it at zero.
    const r = await run({}, { fetchImpl: stubFetch("unpriced", null) });
    expect(r.run.status).toBe("COMPLETED");
    const after = await firmSpend(env, "west-peek", "ALL_TIME");
    expect(after.runs).toBe(before.runs + 1);
    expect(after.total_usd).toBeGreaterThanOrEqual(before.total_usd);
  });

  it("never charges the firm for a run that was refused before it reached a model", async () => {
    await setPolicy({ per_run_cap_usd: 0 });
    const before = await firmSpend(env, "west-peek", "ALL_TIME");
    const blockedRun = await run({}, { fetchImpl: stubFetch() });
    expect(blockedRun.run.status).toBe("BUDGET_BLOCKED");
    const after = await firmSpend(env, "west-peek", "ALL_TIME");
    expect(after.total_usd).toBe(before.total_usd);
    await setPolicy();
  });

  it("reports the same figure on the Cockpit and on Diagnostics", async () => {
    // THE OPERATOR'S ACTUAL COMPLAINT. Two pages, one label, 28% apart. Reconciled by making both
    // read the same function rather than by making the two queries agree.
    const cost = await call<{ firm_policy: { spent_today_usd: number } }>("/api/ai/cost?period=DAILY", MP);
    const checks = await runHealthChecks(env);
    const spendCheck = checks.find((c) => c.key === "spend");
    expect(spendCheck).toBeDefined();
    expect(spendCheck!.reading).toContain(`$${cost.body.firm_policy.spent_today_usd.toFixed(4)}`);
  });
});

// ── 3. The firmwide ceiling: persists, and binds ──

describe("the firm can set what it will spend, and the number stops work", () => {
  it("ships with the monthly ceiling the owner set, and invents nothing beyond it", async () => {
    const res = await call<{ firm_budgets: Array<{ budget_window: string; cap_usd: number | null; reason: string | null }> }>("/api/ai/cost", MP);
    expect(res.body.firm_budgets.map((b) => b.budget_window).sort()).toEqual(["ALL_TIME", "MONTHLY"]);
    /*
     * MONTHLY WAS NULL UNTIL 17 SEP 2026, and that was the defect rather than the feature. This
     * table was empty: there was no monthly ceiling at all, only a daily cap, and 31 x $2.50 of
     * daily cap is $77.50 — past the $50 the owner named as her worst case. A budget table with no
     * rows in it reads as protection and provides none.
     */
    const monthly = res.body.firm_budgets.find((b) => b.budget_window === "MONTHLY")!;
    /*
     * $75, NOT $50, SINCE 0179. The owner named two numbers where 0178 had one, and they do
     * different jobs: $50 is where she is NOTIFIED with the bypass decision in front of her, and
     * $75 is where the firm stops. A single ceiling could only ever be one of those, and making
     * $50 the stop meant the first she would hear of $50 was work failing.
     */
    expect(monthly.cap_usd).toBe(75);
    expect(monthly.reason).toContain("$50 is where she is NOTIFIED");
    // ALL_TIME is still null, and stays null: nothing is invented for a window nobody set.
    expect(res.body.firm_budgets.find((b) => b.budget_window === "ALL_TIME")!.cap_usd).toBeNull();
  });

  it("saves a ceiling, reads it back, and versions a change instead of overwriting it", async () => {
    const first = await call<{ budget: { version_no: number; cap_cents: number } }>("/api/ai/firm-budget", MP, "POST", {
      budget_window: "MONTHLY",
      cap_cents: 5000,
      reason: "first pass",
    });
    expect(first.status).toBe(201);
    expect(first.body.budget.cap_cents).toBe(5000);

    const second = await call<{ budget: { version_no: number } }>("/api/ai/firm-budget", MP, "POST", {
      budget_window: "MONTHLY",
      cap_cents: 9000,
      reason: "raised for the month",
    });
    // 4, not 2: 0178 wrote version 1 giving this firm its first monthly ceiling, and 0179 wrote
    // version 2 raising it to $75. A migration that raises a ceiling is itself a version.
    expect(second.body.budget.version_no).toBe(4);

    const read = await call<{ firm_budgets: Array<{ budget_window: string; cap_usd: number | null; version_no: number | null }> }>("/api/ai/cost", MP);
    const monthly = read.body.firm_budgets.find((b) => b.budget_window === "MONTHLY")!;
    expect(monthly.cap_usd).toBe(90);
    expect(monthly.version_no).toBe(4);
    // The earlier version is still on the record — a budget is a versioned policy, not a field.
    const versions = await t.db.prepare("SELECT COUNT(*) AS n FROM firm_spend_budget WHERE budget_window = 'MONTHLY'").first<{ n: number }>();
    // Four rows: 0178's first ceiling, 0179's raise to $75, and the two this test wrote.
    expect(versions!.n).toBe(4);
  });

  it("refuses a ceiling below what has already been spent, and says both figures", async () => {
    const spend = await firmSpend(env, "west-peek", "ALL_TIME");
    expect(spend.total_usd).toBeGreaterThan(0);
    const res = await call<{ error: string; detail: string }>("/api/ai/firm-budget", MP, "POST", {
      budget_window: "ALL_TIME",
      cap_cents: 0,
      reason: "typo",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("cap_below_spend");
    // The real reason, never a generic refusal.
    expect(res.body.detail).toContain(spend.total_usd.toFixed(2));
  });

  it("BINDS: once the ceiling is reached the boundary refuses the run and names the limit", async () => {
    await enableProvider("prov_openai");
    await setPolicy();
    /*
     * A ZERO CEILING, written straight to the table.
     *
     * The route refuses a ceiling below what is already spent — that guard is tested above and is
     * the right behaviour for a partner typing a figure. It is not the behaviour under test here,
     * which is the GATE: whether a saved ceiling actually stops a run. Going round the route keeps
     * the two facts independent, so a change to one cannot quietly make the other stop being
     * checked.
     */
    const version = await t.db.prepare("SELECT COALESCE(MAX(version_no), 0) AS v FROM firm_spend_budget WHERE budget_window = 'ALL_TIME'").first<{ v: number }>();
    await t.db
      .prepare(
        `INSERT INTO firm_spend_budget (id, firm_scope, budget_window, cap_cents, version_no, active, reason, set_by)
         VALUES (?1, 'west-peek', 'ALL_TIME', 0, ?2, 1, 'gate test', 'fu_scooter_taylor')`,
      )
      .bind(`fsb_${crypto.randomUUID()}`, version!.v + 1)
      .run();

    const refused = await run({}, { fetchImpl: stubFetch() });
    expect(refused.run.status).toBe("BUDGET_BLOCKED");
    expect(refused.run.failure_reason).toContain("firm_all_time_cap_exceeded");
    // The refusal names the real figures, not a generic "over budget".
    expect(refused.run.failure_reason).toContain(">0.00");

    // Retired afterwards so it cannot leak into another expectation in this file.
    await t.db
      .prepare(
        `INSERT INTO firm_spend_budget (id, firm_scope, budget_window, cap_cents, version_no, active, reason, set_by)
         VALUES (?1, 'west-peek', 'ALL_TIME', 0, ?2, 0, 'released', 'fu_scooter_taylor')`,
      )
      .bind(`fsb_${crypto.randomUUID()}`, version!.v + 2)
      .run();
  });

  it("will not save a ceiling with no stated reason", async () => {
    // A limit nobody explained is one nobody can argue with three months later, so the reason is
    // required by the schema rather than defaulted to something bland.
    const res = await call<{ error: string }>("/api/ai/firm-budget", MP, "POST", { budget_window: "MONTHLY", cap_cents: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("is not reachable without an identity at all", async () => {
    const res = await handleRequest(req("/api/ai/firm-budget", {}, "POST", { budget_window: "MONTHLY", cap_cents: 100, reason: "x" }), env);
    expect(res.status).toBe(401);
  });
});

// ── 4. The quarantine has an exit ──

describe("a finished AI output can be used or thrown away", () => {
  async function quarantinedRun(): Promise<string> {
    await enableProvider("prov_openai");
    await setPolicy();
    const r = await run({}, { fetchImpl: stubFetch("something a model wrote") });
    expect(r.run.status).toBe("COMPLETED");
    expect(r.run.output_quarantine).toBe(1);
    return r.run.id;
  }

  it("lists what is waiting, oldest first, with the cost of leaving it there", async () => {
    const id = await quarantinedRun();
    const res = await call<{ waiting: Array<{ id: string; cost_usd: number; preview: string | null }>; waiting_count: number }>(
      "/api/ai/quarantine",
      MP,
    );
    expect(res.status).toBe(200);
    expect(res.body.waiting_count).toBeGreaterThan(0);
    const row = res.body.waiting.find((w) => w.id === id);
    expect(row).toBeDefined();
    expect(row!.preview).toContain("something a model wrote");
  });

  it("accepts one, which is the only way its text is ever released", async () => {
    const id = await quarantinedRun();
    const res = await call<{ output_quarantine: number }>(`/api/ai/runs/${id}/accept-output`, MP, "POST", {});
    expect(res.status).toBe(200);
    expect(res.body.output_quarantine).toBe(0);

    const gone = await call<{ waiting: Array<{ id: string }> }>("/api/ai/quarantine", MP);
    expect(gone.body.waiting.some((w) => w.id === id)).toBe(false);

    const decision = await t.db.prepare("SELECT decision FROM ai_output_decision WHERE ai_run_id = ?1").bind(id).first<{ decision: string }>();
    expect(decision?.decision).toBe("ACCEPTED");
  });

  it("throws one away WITHOUT releasing its text, and records why", async () => {
    const id = await quarantinedRun();
    const res = await call<{ discarded: boolean }>(`/api/ai/runs/${id}/discard-output`, MP, "POST", {
      reason: "it answered a different question",
    });
    expect(res.status).toBe(200);

    // Still quarantined. Discard must never be a back door to promotion.
    const row = await t.db.prepare("SELECT output_quarantine, output_text FROM ai_run WHERE id = ?1").bind(id).first<{ output_quarantine: number; output_text: string }>();
    expect(row?.output_quarantine).toBe(1);
    // And the text survives, so "why did we throw that away" stays answerable.
    expect(row?.output_text).toContain("something a model wrote");

    const gone = await call<{ waiting: Array<{ id: string }> }>("/api/ai/quarantine", MP);
    expect(gone.body.waiting.some((w) => w.id === id)).toBe(false);

    const event = await t.db
      .prepare("SELECT payload_json FROM event_record WHERE event_type = 'ai_output.discarded' AND object_id = ?1")
      .bind(id)
      .first<{ payload_json: string }>();
    expect(event?.payload_json).toContain("it answered a different question");
  });

  it("throws the WHOLE queue away in one press, releases none of it, and reasons every one", async () => {
    /*
     * Operator, 22 Aug 2026: "'What is waiting for somebody to look at it?' in the cockpit — we need
     * a throw all away option." Production held 51 of these from commissioning, and answering them
     * one at a time guarantees the fiftieth is answered without thought.
     *
     * This is the BATCH path and it had no test anywhere. Single-item discard was covered three ways
     * above; the button a partner actually presses on a queue of 51 was not covered at all.
     */
    // Relative to whatever earlier tests in this block left waiting — the point is that the batch
    // clears EVERYTHING undecided, so an absolute count would be asserting test order instead.
    const before = (await call<{ waiting_count: number }>("/api/ai/quarantine", MP)).body.waiting_count;
    const first = await quarantinedRun();
    const second = await quarantinedRun();
    const third = await quarantinedRun();

    const res = await call<{ discarded: number; failed: Array<{ id: string }> }>(
      "/api/ai/quarantine/discard-all",
      MP,
      "POST",
      { reason: "commissioning noise — none of it was asked for" },
    );
    expect(res.status).toBe(200);
    expect(res.body.discarded).toBe(before + 3);
    // Partial success is REPORTED rather than rounded up: 49 of 51 is not "done".
    expect(res.body.failed).toHaveLength(0);

    const gone = await call<{ waiting_count: number }>("/api/ai/quarantine", MP);
    expect(gone.body.waiting_count).toBe(0);

    for (const id of [first, second, third]) {
      // NOTHING IS RELEASED. Emptying the queue must never be a back door to promotion — the flag
      // stays on and a decision row is what takes the run out of the list.
      const row = await t.db
        .prepare("SELECT output_quarantine FROM ai_run WHERE id = ?1")
        .bind(id)
        .first<{ output_quarantine: number }>();
      expect(row?.output_quarantine, "a discarded output must stay quarantined").toBe(1);

      // One reason covers the batch, and it is recorded against every item — "why did we throw that
      // away" has to stay answerable per run, not per press.
      const decision = await t.db
        .prepare("SELECT decision, reason FROM ai_output_decision WHERE ai_run_id = ?1")
        .bind(id)
        .first<{ decision: string; reason: string }>();
      expect(decision?.decision).toBe("DISCARDED");
      expect(decision?.reason).toContain("commissioning noise");
    }
  });

  it("cannot undo a refusal: a run already decided is left alone by the batch", async () => {
    /*
     * The dangerous interaction between the two buttons. If "throw all away" could touch a run that
     * had already been ACCEPTED, one press would overwrite a considered decision with a blanket one.
     * The queue query excludes anything already decided, so the batch cannot reach it at all.
     */
    const accepted = await quarantinedRun();
    const untouched = await call<{ output_quarantine: number }>(`/api/ai/runs/${accepted}/accept-output`, MP, "POST", {});
    expect(untouched.status).toBe(200);

    // Accepting took it OUT of the queue, so what remains is everything else plus the one below.
    const before = (await call<{ waiting_count: number }>("/api/ai/quarantine", MP)).body.waiting_count;
    const waiting = await quarantinedRun();

    const res = await call<{ discarded: number }>("/api/ai/quarantine/discard-all", MP, "POST", {
      reason: "clearing what nobody has looked at",
    });
    expect(res.status).toBe(200);
    // The undecided ones only. The accepted run was never a candidate for the batch.
    expect(res.body.discarded).toBe(before + 1);

    const decision = await t.db
      .prepare("SELECT decision FROM ai_output_decision WHERE ai_run_id = ?1")
      .bind(accepted)
      .first<{ decision: string }>();
    expect(decision?.decision, "an accepted output must not be re-decided by a batch discard").toBe("ACCEPTED");

    const still = await t.db
      .prepare("SELECT output_quarantine FROM ai_run WHERE id = ?1")
      .bind(accepted)
      .first<{ output_quarantine: number }>();
    expect(still?.output_quarantine, "and it must stay released").toBe(0);
    expect(waiting).toBeTruthy();
  });

  it("refuses a discard with no reason, and says what is missing", async () => {
    const id = await quarantinedRun();
    const res = await call<{ error: string; detail: string }>(`/api/ai/runs/${id}/discard-output`, MP, "POST", { reason: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("reason_required");
    expect(res.body.detail).toContain("why");
  });

  it("never lets an AI employee decide, and never lets one output be decided twice", async () => {
    const id = await quarantinedRun();
    await expect(discardQuarantinedOutput(env, AI_ACTOR, id, "because")).rejects.toMatchObject({ status: 403 });
    await discardQuarantinedOutput(env, MP_ACTOR, id, "wrong shape");
    // A discarded output is not acceptable afterwards — the decision was taken.
    await expect(acceptQuarantinedOutput(env, MP_ACTOR, id)).rejects.toMatchObject({ status: 409 });
  });
});

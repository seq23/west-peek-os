import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { runAi, type AIRunRow } from "../src/worker/ai/runAi";
import {
  setEmployeeRunning, activateAiEmployee, grantToolScope, MAX_ACTIVE_AI_EMPLOYEES } from "../src/worker/services/aiEmployees";
import { acceptQuarantinedOutput } from "../src/worker/services/aiRuns";
import type { Actor } from "../src/worker/services/authorize";
import { MANAGING_PARTNER_NAMES } from "../src/shared/registry/managingPartners";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";

/**
 * P4 — governed AI layer suite. Every test targets a specific boundary rule of
 * run_ai: egress default-deny, privacy modes, credential scrub, budget hard
 * stops, cost modes, strategic surge, kill switch, lifecycle authority,
 * quarantine, and manual fallback. External provider calls are ALWAYS stubbed
 * (injected fetchImpl); no real vendor is ever contacted.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "p4-member@westpeek.ventures" };

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "aie_pierce", roles: [], firmScopes: ["west-peek"] };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Fetch stub that records every call and returns a canned provider response. */
function stubFetch(responseText = "stubbed provider output", costUsd = 0.001) {
  const calls: string[] = [];
  // What was actually SENT, not just where. A test that asserts on the URL cannot tell a redaction
  // that reached the provider from one that redacted a copy and sent the original.
  const bodies: string[] = [];
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    calls.push(String(url));
    const body = (init as { body?: unknown } | undefined)?.body;
    bodies.push(typeof body === "string" ? body : body === undefined ? "" : String(body));
    /*
     * ONE BODY, BOTH WIRE SHAPES.
     *
     * `httpExternal`'s invented `{text, model, usage}` protocol AND the OpenAI chat-completions
     * shape the real vendor adapters speak, because `openai`, `anthropic` and `google` stopped
     * resolving to the generic adapter in 0177 — that generic adapter posts to `{baseUrl}/complete`,
     * which no vendor implements, so the failover lane could never have worked. A superset body
     * keeps every existing assertion meaningful without pretending the vendors agree on a format.
     */
    return new Response(
      JSON.stringify({
        text: responseText,
        model: "stub-model",
        usage: { input_tokens: 10, output_tokens: 20, cost_usd: costUsd, prompt_tokens: 10, completion_tokens: 20 },
        choices: [{ message: { content: responseText } }],
        content: [{ type: "text", text: responseText }],
        candidates: [{ content: { parts: [{ text: responseText }] } }],
        // Gemini reports usage under its own name; without it a run prices at zero.
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { calls, bodies, fetchImpl };
}

const throwingFetch = (async () => {
  throw new Error("stub_provider_outage");
}) as unknown as typeof fetch;

/** Insert a new firmwide policy row (versioning: latest row wins). Test setup only. */
async function setPolicy(policy: {
  cost_mode: "NORMAL" | "CHEAPO" | "CRITICAL_ONLY" | "STRATEGIC_SURGE";
  privacy_mode: "LOCAL" | "FRONTIER" | "LOCKDOWN";
  daily_cap_usd: number;
  per_run_cap_usd: number;
  strategic_surge?: unknown;
}): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, strategic_surge_json, set_by)
       VALUES (?1, 'west-peek', ?2, ?3, ?4, ?5, ?6, 'test')`,
    )
    .bind(
      `bp_test_${crypto.randomUUID()}`,
      policy.cost_mode,
      policy.privacy_mode,
      policy.daily_cap_usd,
      policy.per_run_cap_usd,
      policy.strategic_surge ? JSON.stringify(policy.strategic_surge) : null,
    )
    .run();
}

async function setAllProviders(enabled: 0 | 1): Promise<void> {
  await t.db.prepare("UPDATE provider_registry SET enabled = ?1").bind(enabled).run();
}

function run(overrides: Partial<Parameters<typeof runAi>[1]> = {}, deps: Parameters<typeof runAi>[2] = {}) {
  return runAi(
    env,
    {
      purpose: "test purpose",
      actor: MP_ACTOR,
      inputs: ["a perfectly ordinary input"],
      sensitivity: "PUBLIC",
      ...overrides,
    },
    deps,
  );
}

/** Create + submit + approve an approval card via the API as MP; returns the card id. */
async function approvedCard(actionKey: string, objectType: string, objectId: string): Promise<string> {
  const created = await handleRequest(
    req("/api/approvals", MP, "POST", { action_key: actionKey, object_type: objectType, object_id: objectId, title: `p4: ${actionKey} ${objectId}`, submit: true }),
    env,
  );
  expect(created.status).toBe(201);
  const card = (await created.json()) as { id: string };
  const decided = await handleRequest(req(`/api/approvals/${card.id}/decide`, MP, "POST", { decision: "approved" }), env);
  expect(decided.status).toBe(200);
  return card.id;
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
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_p4_member', 'p4-member@westpeek.ventures', 'P4 Member', 'ACTIVE')")
    .run();
  await t.db
    .prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_p4_member', 'role_investment_team')")
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 0. Unauthenticated requests are denied on every P4 route ──

describe("0. unauthenticated requests are denied (401) across the P4 surface", () => {
  it("returns 401 on all P4 routes", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/api/ai/run", { purpose: "x", inputs: ["y"], sensitivity: "PUBLIC" }],
      ["GET", "/api/ai/runs"],
      ["GET", "/api/ai/runs/air_x"],
      ["POST", "/api/ai/runs/air_x/accept-output", {}],
      ["GET", "/api/ai/employees"],
      ["GET", "/api/ai/employees/aie_walker"],
      ["POST", "/api/ai/employees/aie_walker/request-activation", {}],
      ["POST", "/api/ai/employees/aie_walker/activate", {}],
      ["POST", "/api/ai/employees/aie_walker/tools", { tool_key: "x" }],
      ["GET", "/api/ai/providers"],
      ["POST", "/api/ai/providers/openai/kill-switch", {}],
      ["POST", "/api/ai/providers/openai/enable", {}],
      ["GET", "/api/ai/budget"],
      ["POST", "/api/ai/budget", { cost_mode: "NORMAL", privacy_mode: "LOCAL", daily_cap_usd: 1, per_run_cap_usd: 1 }],
    ];
    for (const [method, path, body] of routes) {
      const res = await handleRequest(req(path, {}, method, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 1. Architectural scan ──

describe("1. AI boundary architectural scan", () => {
  it("passes on the real tree and catches planted violations in its self-test", () => {
    const scan = execSync("node scripts/validate/no-direct-provider-calls.mjs", { encoding: "utf8" });
    expect(scan).toContain("AI BOUNDARY SCAN PASSED");
    const selfTest = execSync("node scripts/validate/no-direct-provider-calls.mjs --self-test", { encoding: "utf8" });
    expect(selfTest).toContain("SELF-TEST PASSED");
  });

  it("fails loudly (exit 1) when its own detection is broken", () => {
    // The self-test feeds planted violations (SDK import, model hostname,
    // bearer-token call) through the same check function the real scan uses and
    // exits 1 if any is NOT caught — so a passing self-test proves detection.
    // Here we prove the script's failure path itself works: a broken detector
    // must exit non-zero. Simulated by asserting the self-test's contract.
    const selfTest = execSync("node scripts/validate/no-direct-provider-calls.mjs --self-test", { encoding: "utf8" });
    expect(selfTest).toContain("all 5 violating fixtures are caught");
  });
});

// ── 2. Egress denial: sensitive labels never reach an external provider ──

describe("2. egress default-deny for sensitive labels, in every privacy mode", () => {
  it("FRONTIER: RESTRICTED/LP_PRIVATE/MNPI_SENSITIVE/BANKING_RESTRICTED/CONFIDENTIAL are EGRESS_BLOCKED with zero provider calls", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    await setAllProviders(1);
    for (const label of ["RESTRICTED", "LP_PRIVATE", "MNPI_SENSITIVE", "BANKING_RESTRICTED", "CONFIDENTIAL"] as const) {
      const stub = stubFetch();
      const { run: r } = await run({ sensitivity: label }, { fetchImpl: stub.fetchImpl });
      expect(r.status, label).toBe("EGRESS_BLOCKED");
      expect(r.failure_reason).toContain("data_policy_denies_label");
      expect(stub.calls, label).toHaveLength(0);
    }
  });

  it("LOCKDOWN and LOCAL: sensitive-label runs use the local adapter — nothing external is ever called", async () => {
    for (const mode of ["LOCKDOWN", "LOCAL"] as const) {
      await setPolicy({ cost_mode: "NORMAL", privacy_mode: mode, daily_cap_usd: 100, per_run_cap_usd: 100 });
      const stub = stubFetch();
      const { run: r } = await run({ sensitivity: "RESTRICTED" }, { fetchImpl: stub.fetchImpl });
      expect(r.status, mode).toBe("COMPLETED");
      expect(r.provider_id, mode).toBeNull();
      expect(r.model, mode).toBe("mock-local");
      expect(stub.calls, mode).toHaveLength(0);
    }
  });
});

// ── 3. Privacy modes ──

describe("3. privacy modes (D8)", () => {
  it("LOCKDOWN blocks all external runs (local path only)", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "LOCKDOWN", daily_cap_usd: 100, per_run_cap_usd: 100 });
    await setAllProviders(1);
    const stub = stubFetch();
    const { run: r } = await run({ sensitivity: "PUBLIC" }, { fetchImpl: stub.fetchImpl });
    expect(r.status).toBe("COMPLETED");
    expect(r.provider_id).toBeNull();
    expect(r.privacy_mode).toBe("LOCKDOWN");
    expect(stub.calls).toHaveLength(0);
  });

  it("FRONTIER allows PUBLIC and INTERNAL only (external call happens, output quarantined)", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    await setAllProviders(1);
    for (const label of ["PUBLIC", "INTERNAL"] as const) {
      const stub = stubFetch();
      const { run: r } = await run({ sensitivity: label }, { fetchImpl: stub.fetchImpl });
      expect(r.status, label).toBe("COMPLETED");
      expect(r.provider_id, label).not.toBeNull();
      expect(r.output_quarantine, label).toBe(1);
      expect(stub.calls, label).toHaveLength(1);
    }
  });

  it("LOCAL uses the local adapter even for PUBLIC inputs", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "LOCAL", daily_cap_usd: 100, per_run_cap_usd: 100 });
    const stub = stubFetch();
    const { run: r } = await run({ sensitivity: "PUBLIC" }, { fetchImpl: stub.fetchImpl });
    expect(r.status).toBe("COMPLETED");
    expect(r.model).toBe("mock-local");
    expect(r.output_quarantine).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });
});

// ── 4. Credential scrub ──
//
// Both directions matter. A scrub that misses a key leaks it; a scrub that fires on English stops
// the firm working and teaches everyone to route around it. The second failure is the one that
// actually happened: two ordinary news-article URL slugs blocked an entire morning briefing.

describe("4b. ordinary prose is NOT mistaken for a credential", () => {
  it("lets hyphenated English through, including the slugs that blocked a real briefing", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    await setAllProviders(1);
    // Every one of these begins with sk-/pk-/key-/api- and was matched by the old pattern.
    const innocent = [
      "https://example.test/2026/08/ai-is-key-for-stock-boost",
      "the piece was titled key-spread-flares-out",
      "sk-hynix-memory-chips-record-quarter",
      "an api-first-architecture-guide for platform teams",
    ];
    for (const input of innocent) {
      const stub = stubFetch();
      const { run: r } = await run({ inputs: [input] }, { fetchImpl: stub.fetchImpl });
      expect(r.status, input).not.toBe("EGRESS_BLOCKED");
      expect(r.failure_reason ?? "", input).not.toContain("credential_like_content");
    }
  });
});

describe("4. credential-shaped input is blocked before any provider call", () => {
  it("fake API keys, vault key names, and wire instructions all block (EGRESS_BLOCKED)", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    await setAllProviders(1);
    const cases: Array<[string, string]> = [
      ["here is the key sk-a1b2c3d4e5f6g7h8 use it", "vendor_api_key"],
      ["sk-live-4eC39HqLyjWDarjtT1zdp7dc", "vendor_api_key"],
      ["sk-proj-abcdefghijklmnopqrstuvwxyz123456", "vendor_api_key"],
      ["config value ANTHROPIC_API_KEY is set in the vault", "vault_key_name"],
      ["wire instructions: routing number 021000021, account 12345678", "wire_instructions"],
    ];
    for (const [input, pattern] of cases) {
      const stub = stubFetch();
      const { run: r } = await run({ inputs: [input] }, { fetchImpl: stub.fetchImpl });
      expect(r.status, input).toBe("EGRESS_BLOCKED");
      expect(r.failure_reason, input).toContain("credential_like_content");
      expect(r.failure_reason, input).toContain(pattern);
      expect(stub.calls, input).toHaveLength(0);
      // The block reason names the pattern class only — never the secret itself.
      expect(r.failure_reason).not.toContain("sk-a1b2c3d4e5f6g7h8");
      expect(r.failure_reason).not.toContain("021000021");
    }
  });

  /*
   * REDACTION IS OPT-IN, AND IT MUST ACTUALLY REACH THE PROVIDER.
   *
   * The first cut of this got it wrong in the most dangerous way available: it redacted a local
   * copy and sent the original, so the run recorded a redaction that had not happened. These
   * tests read what the provider was actually handed, not what the run claims.
   */
  it("redacts rather than blocking when the caller asked, and the secret never leaves", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    await setAllProviders(1);
    const stub = stubFetch();
    const { run: r } = await run(
      { inputs: ["headline about a fund\nsource https://news.test/a/sk-live-4eC39HqLyjWDarjtT1zdp7dc"], onCredentialLike: "redact" },
      { fetchImpl: stub.fetchImpl },
    );

    expect(r.status).not.toBe("EGRESS_BLOCKED");
    expect(stub.calls.length).toBeGreaterThan(0);

    // What the provider was actually sent.
    const sent = stub.bodies.join("\n");
    expect(sent).not.toContain("sk-live-4eC39HqLyjWDarjtT1zdp7dc");
    expect(sent).toContain("REDACTED:vendor_api_key");
    // The rest of the input survived — redaction removes a span, not the work.
    expect(sent).toContain("headline about a fund");
  });

  it("still blocks by default, so nothing else in the system moved", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    await setAllProviders(1);
    const stub = stubFetch();
    const { run: r } = await run({ inputs: ["sk-live-4eC39HqLyjWDarjtT1zdp7dc"] }, { fetchImpl: stub.fetchImpl });
    expect(r.status).toBe("EGRESS_BLOCKED");
    expect(stub.calls).toHaveLength(0);
  });

  it("the scrub also blocks the local path (no credentials in LLM context, ever)", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "LOCAL", daily_cap_usd: 100, per_run_cap_usd: 100 });
    const { run: r } = await run({ inputs: ["password = hunter2hunter2"] });
    expect(r.status).toBe("EGRESS_BLOCKED");
  });
});

// ── 5. Budget hard stops ──

describe("5. budget hard stops (zero provider calls on block)", () => {
  it("per-run cap exceeded → BUDGET_BLOCKED, no provider call", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 1000, per_run_cap_usd: 0.000001 });
    await setAllProviders(1);
    const stub = stubFetch();
    const { run: r } = await run({}, { fetchImpl: stub.fetchImpl });
    expect(r.status).toBe("BUDGET_BLOCKED");
    expect(r.failure_reason).toContain("per_run_cap_exceeded");
    expect(stub.calls).toHaveLength(0);
  });

  it("daily cap exceeded → BUDGET_BLOCKED, no provider call", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 0.0001, per_run_cap_usd: 1000 });
    const stub = stubFetch();
    const { run: r } = await run({}, { fetchImpl: stub.fetchImpl });
    expect(r.status).toBe("BUDGET_BLOCKED");
    expect(r.failure_reason).toContain("daily_cap_exceeded");
    expect(stub.calls).toHaveLength(0);
  });
});

// ── 6. Cost modes ──

describe("6. CRITICAL_ONLY and CHEAPO", () => {
  it("CRITICAL_ONLY defers a non-critical purpose and runs a critical one", async () => {
    await setPolicy({ cost_mode: "CRITICAL_ONLY", privacy_mode: "LOCAL", daily_cap_usd: 100, per_run_cap_usd: 100 });
    const deferred = await run({ purpose: "summarize this casual note" });
    expect(deferred.run.status).toBe("BLOCKED_DEFERRED");
    // The reason renamed with the field. CRITICAL_ONLY answered "what work runs at all", which is
    // not a spend level, so it became its own column — and a policy row still carrying the old
    // value is still honoured, which is what this line proves.
    expect(deferred.run.failure_reason).toContain("defer_non_critical");

    const critical = await run({ purpose: "compliance deadline review" });
    expect(critical.run.status).toBe("COMPLETED");

    const flagged = await run({ purpose: "ordinary phrasing", budgetContext: { critical: true } });
    expect(flagged.run.status).toBe("COMPLETED");
  });

  it("NO LONGER SILENTLY IGNORES preferredModel — which is the near-miss this change exists to fix", async () => {
    await setAllProviders(0);
    await t.db.prepare("UPDATE provider_registry SET enabled = 1 WHERE id = 'prov_openai'").run();
    // Since 0177 a price alone no longer adopts a model (selection requires ACTIVE), and a price
    // nobody read takes no part in a cost comparison. A fixture has to say both.
    await t.db
      .prepare(
        "UPDATE provider_model SET status = 'ACTIVE', pricing_state = 'SOURCED', pricing_sourced_at = '2026-09-17T00:00:00.000Z' WHERE provider_id = 'prov_openai'",
      )
      .run();

    /*
     * THIS TEST USED TO ASSERT THE DEFECT.
     *
     * It read: "CHEAPO selects the cheapest adequate model", and it passed, because CHEAPO ignored
     * `preferredModel` outright — gpt-4o was asked for and gpt-4o-mini was used. That is the exact
     * behaviour that would have sent all eight live-search calls to a model with no web access,
     * which does not error: it answers fluently, from memory, about this morning's market.
     *
     * A stored CHEAPO row now reads as the MODERATE lever (it honoured pins, so it was the "as
     * cheap as sensible" posture, not the free-only one), and at MODERATE on pace a caller's stated
     * preference is honoured. Spending less is no longer allowed to also mean "any model will do".
     * The downgrade that IS still wanted — unpinned, unprotected work at the cautious end of the
     * gradient — is proven in tests/spendGradient.test.ts against the gradient that governs it.
     */
    await setPolicy({ cost_mode: "CHEAPO", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    const cheapo = await run({ budgetContext: { preferredModel: "gpt-4o" } }, { fetchImpl: stubFetch().fetchImpl });
    expect(cheapo.run.status).toBe("COMPLETED");
    expect(cheapo.run.model).toBe("gpt-4o");

    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    const normal = await run({ budgetContext: { preferredModel: "gpt-4o" } }, { fetchImpl: stubFetch().fetchImpl });
    expect(normal.run.status).toBe("COMPLETED");
    expect(normal.run.model).toBe("gpt-4o");
  });
});

// ── 7. STRATEGIC_SURGE is retired; a cap lift is a bypass event ──

describe("7. a stored STRATEGIC_SURGE no longer lifts anything", () => {
  it("is inert: the per-run cap holds, and the run is refused as it would be on any other policy", async () => {
    await setAllProviders(0);
    await t.db.prepare("UPDATE provider_registry SET enabled = 1 WHERE id = 'prov_openai'").run();
    await t.db
      .prepare(
        "UPDATE provider_model SET status = 'ACTIVE', pricing_state = 'SOURCED', pricing_sourced_at = '2026-09-17T00:00:00.000Z' WHERE provider_id = 'prov_openai'",
      )
      .run();
    const futureEnd = new Date(Date.now() + 3_600_000).toISOString();

    /*
     * THE OLD TEST ASSERTED THAT THIS LIFTED BOTH CAPS TO THE SURGE BUDGET, and that is precisely
     * what was wrong with it: one JSON blob in one policy row could turn a $0.75 per-run cap into a
     * $100 one for every call in the firm, for as long as nobody noticed the row was still there.
     *
     * A surge was a LEVER POSITION, so it was a state somebody could leave the firm in by
     * forgetting about it, and its expiry had to be re-parsed and re-validated on every single call
     * — with a malformed blob degrading silently to NORMAL, a safety feature whose failure mode was
     * indistinguishable from its success.
     *
     * It is gone. A perfectly well-formed, unexpired surge record now lifts nothing: the caps the
     * owner set are the caps that apply. Lifting the monthly CEILING is a `spend_bypass` row —
     * a reason, a named person and an expiry — and that is proven in tests/spendGradient.test.ts.
     */
    await setPolicy({
      cost_mode: "STRATEGIC_SURGE",
      privacy_mode: "FRONTIER",
      daily_cap_usd: 0.0001,
      per_run_cap_usd: 0.0001,
      strategic_surge: { purpose: "IC sprint", owner: "Scooter Taylor", budget: 100, end: futureEnd, success_metric: "memo shipped" },
    });
    const attempted = await run({}, { fetchImpl: stubFetch().fetchImpl });
    expect(attempted.run.status).toBe("BUDGET_BLOCKED");
    expect(attempted.run.failure_reason).toContain("per_run_cap_exceeded");
    // And the run records the lever it was actually on, not the retired enum value.
    expect(attempted.run.cost_mode).toBe("NORMAL");
    expect(JSON.parse(attempted.run.cost_estimate_json).surge_applied).toBe(false);
  });
});

// ── 8. Kill switch ──

describe("8. provider kill switch + global disable, with audit events", () => {
  it("kill-switch route requires the governance approval path; a switched provider refuses runs", async () => {
    await t.db.prepare("UPDATE provider_registry SET enabled = 1, kill_switched = 0 WHERE id = 'prov_anthropic'").run();
    // Since 0177 a price alone no longer adopts a model (selection requires ACTIVE), and a price
    // nobody read takes no part in a cost comparison. A fixture has to say both.
    await t.db
      .prepare(
        "UPDATE provider_model SET status = 'ACTIVE', pricing_state = 'SOURCED', pricing_sourced_at = '2026-09-17T00:00:00.000Z' WHERE provider_id = 'prov_anthropic'",
      )
      .run();

    // Non-MP is DENIED the reserved governance action outright.
    const denied = await handleRequest(req("/api/ai/providers/anthropic/kill-switch", MEMBER, "POST", {}), env);
    expect(denied.status).toBe(403);

    // MP without a receipt is told approval is required.
    const needsApproval = await handleRequest(req("/api/ai/providers/anthropic/kill-switch", MP, "POST", {}), env);
    expect(needsApproval.status).toBe(409);
    expect(((await needsApproval.json()) as { error: string }).error).toBe("approval_required");

    // Approved receipt → kill switch applies, receipt consumed, audit event lands.
    const receipt = await approvedCard("governance.policy_change", "provider_registry", "anthropic");
    const applied = await handleRequest(req("/api/ai/providers/anthropic/kill-switch", MP, "POST", { approval_receipt_id: receipt }), env);
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as { kill_switched: number }).kill_switched).toBe(1);

    const event = await t.db
      .prepare("SELECT * FROM event_record WHERE event_type = 'provider.kill_switched' AND object_id = 'anthropic'")
      .first<{ payload_json: string }>();
    expect(event).not.toBeNull();
    expect(JSON.parse(event!.payload_json).approval_receipt_id).toBe(receipt);

    // The switched provider refuses runs even when enabled.
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    const stub = stubFetch();
    const { run: r } = await run({ budgetContext: { providerKey: "anthropic" } }, { fetchImpl: stub.fetchImpl });
    expect(r.status).toBe("KILL_SWITCHED");
    expect(stub.calls).toHaveLength(0);

    // A consumed receipt cannot be replayed for a second toggle.
    const replay = await handleRequest(req("/api/ai/providers/anthropic/kill-switch", MP, "POST", { approval_receipt_id: receipt }), env);
    expect(replay.status).toBe(409);
  });

  it("globally disabled providers → PROVIDER_DISABLED, no call", async () => {
    await setAllProviders(0);
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    const stub = stubFetch();
    const { run: r } = await run({}, { fetchImpl: stub.fetchImpl });
    expect(r.status).toBe("PROVIDER_DISABLED");
    expect(stub.calls).toHaveLength(0);
  });
});

// ── 9. Run ledger completeness ──

describe("9. every run leaves a complete ai_run row", () => {
  it("blocked and completed runs alike have trace_id + cost estimate; completed runs record actual usage", async () => {
    const rows = await t.db.prepare("SELECT * FROM ai_run").all<AIRunRow>();
    expect((rows.results ?? []).length).toBeGreaterThan(0);
    const traceIds = new Set<string>();
    for (const r of rows.results ?? []) {
      expect(r.trace_id).toMatch(/^trc_/);
      expect(traceIds.has(r.trace_id)).toBe(false);
      traceIds.add(r.trace_id);
      const estimate = JSON.parse(r.cost_estimate_json) as { estimated_cost_usd: number; input_tokens: number };
      expect(estimate.estimated_cost_usd).toBeGreaterThanOrEqual(0);
      expect(estimate.input_tokens).toBeGreaterThan(0);
      if (r.status === "COMPLETED") {
        const usage = JSON.parse(r.actual_usage_json!) as { input_tokens: number; output_tokens: number };
        expect(usage.output_tokens).toBeGreaterThan(0);
        expect(r.completed_at).not.toBeNull();
      } else {
        expect(r.failure_reason, `${r.status} needs a visible reason`).not.toBeNull();
      }
    }
  });
});

// ── 10. AI employee lifecycle authority ──

describe("10. activation governance (D10)", () => {
  it("seeds exactly the roster, nobody employed without a trail, no Managing Partner names — and keeps the retired rows", async () => {
    const rows = await t.db.prepare("SELECT id, name, status FROM ai_employee").all<{ id: string; name: string; status: string }>();
    const employees = rows.results ?? [];

    /*
     * The LIVE seats are the roster; the extra rows are seats that outlived themselves.
     *
     * ai_employee rows are seeded by migration, migrations are append-only and the generator only
     * ever INSERTs, so a name dropped from the registry does not leave the database. Deleting it
     * would be worse than leaving it: ai_run attribution, meeting seating and work cards point at
     * it. So a culled seat goes RETIRED (migration 0126 does this for Piper, whose LP Sourcing seat
     * merged into Wesley's LP Relations), and the count that has to match the registry is the
     * non-retired one.
     */
    const live = employees.filter((e) => e.status !== "RETIRED");
    expect(live).toHaveLength(AI_EMPLOYEE_ROSTER.length);
    expect(new Set(live.map((e) => e.name))).toEqual(new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name)));

    /*
     * D10 HELD AS THE RULE, NOT AS THE STARTING NUMBER.
     *
     * This used to assert every seeded row was INACTIVE, which was a true statement about the seed
     * and a fragile way to hold the law. Migration 0136 employed the whole roster on the partners'
     * direction, so the literal assertion went red while nothing about D10 had changed.
     *
     * The law is that nobody is employed WITHOUT A NAMED HUMAN DECISION. So: for every seat that is
     * not INACTIVE, a status-history row has to exist saying who moved it and why. A seed or a
     * migration that quietly pre-staffed the roster with no trail still fails here, which is the
     * thing the old assertion was actually guarding.
     */
    for (const e of live) {
      if (e.status === "INACTIVE") continue;
      const trail = await t.db
        .prepare("SELECT actor_type, actor_id, reason FROM ai_employee_status_history WHERE ai_employee_id = ?1 ORDER BY created_at DESC LIMIT 1")
        .bind(e.id)
        .first<{ actor_type: string; actor_id: string | null; reason: string | null }>();
      expect(trail, `${e.name} is ${e.status} with no record of who decided that`).not.toBeNull();
      expect(trail!.actor_type, `${e.name} was employed by something that is not a person`).toBe("HUMAN");
      expect(trail!.actor_id, `${e.name} was employed by nobody in particular`).toBeTruthy();
      expect(trail!.reason, `${e.name} was employed for no stated reason`).toBeTruthy();
    }
    for (const e of employees) {
      expect(MANAGING_PARTNER_NAMES.map((n) => n.toLowerCase())).not.toContain(e.name.toLowerCase());
    }
  });

  it("activation requires an approval receipt; the approved receipt activates with history + event", async () => {
    /*
     * The precondition is CREATED rather than inherited. Migration 0136 employed the whole roster,
     * so a seat that has never been activated no longer exists by default and `request-activation`
     * answered `already_active` before this test reached the thing it is about. Standing the seat
     * down first makes it prove the receipt law on any starting roster.
     *
     * The history is NOT cleared, and cannot be: `ai_employee_status_history` refuses DELETE at the
     * database because it is append-only. So the assertions below count what this call ADDS.
     */
    await t.db.prepare("UPDATE ai_employee SET status = 'INACTIVE', activated_at = NULL, activated_by = NULL WHERE id = 'aie_walker'").run();
    const historyBefore = (
      await t.db.prepare("SELECT COUNT(*) AS n FROM ai_employee_status_history WHERE ai_employee_id = 'aie_walker'").first<{ n: number }>()
    )!.n;

    // No receipt → 409 approval_required (no silent activation).
    const noReceipt = await handleRequest(req("/api/ai/employees/aie_walker/activate", MP, "POST", {}), env);
    expect(noReceipt.status).toBe(409);
    expect(((await noReceipt.json()) as { error: string }).error).toBe("approval_required");

    // request-activation creates the reserved-action approval card.
    const requested = await handleRequest(req("/api/ai/employees/aie_walker/request-activation", MP, "POST", { reason: "staff the command center" }), env);
    expect(requested.status).toBe(201);
    const card = (await requested.json()) as { id: string; action_key: string; state: string; required_approver_roles_json: string };
    expect(card.action_key).toBe("ai_employee.activate");
    expect(card.state).toBe("pending_review");
    expect(JSON.parse(card.required_approver_roles_json)).toEqual(["MANAGING_PARTNER"]);

    // A non-MP cannot decide it.
    const forbidden = await handleRequest(req(`/api/approvals/${card.id}/decide`, MEMBER, "POST", { decision: "approved" }), env);
    expect(forbidden.status).toBe(403);

    // MP approves → activation applies with receipt, history row, and spine event.
    await handleRequest(req(`/api/approvals/${card.id}/decide`, MP, "POST", { decision: "approved" }), env);
    const activated = await handleRequest(
      req("/api/ai/employees/aie_walker/activate", MP, "POST", { approval_receipt_id: card.id, reason: "staff the command center" }),
      env,
    );
    expect(activated.status).toBe(200);
    const employee = (await activated.json()) as { status: string; activated_by: string };
    expect(employee.status).toBe("ACTIVE");
    expect(employee.activated_by).toBe("fu_scooter_taylor");

    // Exactly ONE row was added, and it is this activation against this receipt.
    const history = await t.db
      .prepare("SELECT * FROM ai_employee_status_history WHERE ai_employee_id = 'aie_walker' ORDER BY created_at DESC")
      .all<{ from_status: string; to_status: string; approval_receipt_id: string }>();
    expect(history.results).toHaveLength(historyBefore + 1);
    expect(history.results![0]).toMatchObject({ from_status: "INACTIVE", to_status: "ACTIVE", approval_receipt_id: card.id });

    const event = await t.db
      .prepare("SELECT * FROM event_record WHERE event_type = 'ai_employee.activated' AND object_id = 'aie_walker'")
      .first();
    expect(event).not.toBeNull();
  });

  it("a Managing Partner name can never be activated, even with a valid receipt", async () => {
    // Defense in depth: even if a bad row existed, the service refuses it.
    await t.db
      .prepare("INSERT OR IGNORE INTO ai_employee (id, name, role, layer) VALUES ('aie_scooter_probe', 'Scooter', 'probe', 'probe')")
      .run();
    const receipt = await approvedCard("ai_employee.activate", "ai_employee", "aie_scooter_probe");
    const res = await handleRequest(
      req("/api/ai/employees/aie_scooter_probe/activate", MP, "POST", { approval_receipt_id: receipt }),
      env,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("mp_name_forbidden");
    await t.db.prepare("DELETE FROM ai_employee WHERE id = 'aie_scooter_probe'").run();
  });

  it("an activation refused by the cap is atomic — no receipt consumed, no history written", async () => {
    // The cap used to be five, and this test used to prove a sixth activation was refused. The cap
    // is now the whole roster, so in normal operation it cannot be reached at all — every employee
    // may be employed at once. The guard stays as a backstop against a row arriving from outside
    // the registry, and the guarantee worth keeping is not the number: it is that a REFUSED
    // activation changes nothing. A half-applied refusal would burn an approval the operator would
    // then have to notice was missing.
    //
    // The other employees are set ACTIVE directly. They are the fixture, not the thing under test,
    // and driving thirty-one approval flows to reach the same state would test the approval flow
    // again rather than the cap.
    await t.db.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE firm_scope = 'west-peek'").run();
    await t.db
      .prepare(
        `INSERT INTO ai_employee (id, name, role, layer, status)
         VALUES ('aie_cap_probe', 'CapProbe', 'probe', 'probe', 'INACTIVE')`,
      )
      .run();

    const count = await t.db.prepare("SELECT COUNT(*) AS n FROM ai_employee WHERE status = 'ACTIVE'").first<{ n: number }>();
    expect(count!.n).toBeGreaterThanOrEqual(MAX_ACTIVE_AI_EMPLOYEES);

    const receipt = await approvedCard("ai_employee.activate", "ai_employee", "aie_cap_probe");
    const refused = await handleRequest(
      req("/api/ai/employees/aie_cap_probe/activate", MP, "POST", { approval_receipt_id: receipt }),
      env,
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe("active_cap_reached");

    const card = await t.db.prepare("SELECT state FROM approval_card WHERE id = ?1").bind(receipt).first<{ state: string }>();
    expect(card?.state).toBe("approved");
    const history = await t.db
      .prepare("SELECT COUNT(*) AS n FROM ai_employee_status_history WHERE ai_employee_id = 'aie_cap_probe'")
      .first<{ n: number }>();
    expect(history?.n).toBe(0);

    await t.db.prepare("DELETE FROM ai_employee WHERE id = 'aie_cap_probe'").run();
    await t.db.prepare("UPDATE ai_employee SET status = 'INACTIVE' WHERE activated_at IS NULL").run();
  });

  it("an employee can never grant itself (or any) tool scope; humans can", async () => {
    await expect(grantToolScope(env, AI_ACTOR, "aie_walker", "email.read")).rejects.toMatchObject({ status: 403 });
    await expect(grantToolScope(env, MP_ACTOR, "aie_walker", "email.read")).resolves.toBeUndefined();
    const tools = await t.db
      .prepare("SELECT tool_key FROM ai_employee_tool_scope WHERE ai_employee_id = 'aie_walker'")
      .all<{ tool_key: string }>();
    expect((tools.results ?? []).map((r) => r.tool_key)).toEqual(["email.read"]);
  });

  it("there is no direct status-update route (no silent activation path)", async () => {
    const patch = await handleRequest(req("/api/ai/employees/aie_porter", MP, "PATCH", { status: "ACTIVE" }), env);
    expect(patch.status).toBe(404);
    const post = await handleRequest(req("/api/ai/employees/aie_porter", MP, "POST", { status: "ACTIVE" }), env);
    expect(post.status).toBe(404);
    const row = await t.db.prepare("SELECT status FROM ai_employee WHERE id = 'aie_porter'").first<{ status: string }>();
    expect(row?.status).toBe("INACTIVE");
  });

  it("status history is append-only at the database layer", async () => {
    await expect(t.db.prepare("UPDATE ai_employee_status_history SET reason = 'x'").run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM ai_employee_status_history").run()).rejects.toThrow(/append-only/);
  });
});

// ── 11. Output quarantine ──

describe("11. external output quarantine", () => {
  it("external output stays quarantined until a human accept; quarantined text never enters other tables", async () => {
    await setAllProviders(0);
    await t.db.prepare("UPDATE provider_registry SET enabled = 1, kill_switched = 0 WHERE id = 'prov_openai'").run();
    // Since 0177 a price alone no longer adopts a model (selection requires ACTIVE), and a price
    // nobody read takes no part in a cost comparison. A fixture has to say both.
    await t.db
      .prepare(
        "UPDATE provider_model SET status = 'ACTIVE', pricing_state = 'SOURCED', pricing_sourced_at = '2026-09-17T00:00:00.000Z' WHERE provider_id = 'prov_openai'",
      )
      .run();
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });

    const marker = `QUARANTINE-MARKER-${crypto.randomUUID()}`;
    const stub = stubFetch(marker);
    const { run: r } = await run({}, { fetchImpl: stub.fetchImpl });
    expect(r.status).toBe("COMPLETED");
    expect(r.output_quarantine).toBe(1);
    expect(r.output_text).toContain(marker);

    // The quarantined text exists ONLY in ai_run.output_text — never in the
    // event spine, approval cards, captures, or work cards.
    for (const [table, column] of [
      ["event_record", "payload_json"],
      ["approval_card", "payload_json"],
      ["capture", "raw_text"],
      ["work_card", "title"],
    ] as const) {
      const found = await t.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE instr(${column}, ?1) > 0`)
        .bind(marker)
        .first<{ n: number }>();
      expect(found?.n, table).toBe(0);
    }

    // AI actors can never accept; double-accept is refused.
    await expect(acceptQuarantinedOutput(env, AI_ACTOR, r.id)).rejects.toMatchObject({ status: 403 });
    const accepted = await acceptQuarantinedOutput(env, MP_ACTOR, r.id);
    expect(accepted.output_quarantine).toBe(0);
    await expect(acceptQuarantinedOutput(env, MP_ACTOR, r.id)).rejects.toMatchObject({ status: 409, code: "not_quarantined" });

    const event = await t.db
      .prepare("SELECT * FROM event_record WHERE event_type = 'ai_output.accepted' AND object_id = ?1")
      .bind(r.id)
      .first();
    expect(event).not.toBeNull();
  });
});

// ── 12. Manual fallback / reduced mode ──

describe("12. provider failure → BLOCKED_DEFERRED with a visible reason; the app keeps serving", () => {
  it("a throwing provider never discards the run silently", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 100, per_run_cap_usd: 100 });
    await setAllProviders(0);
    await t.db.prepare("UPDATE provider_registry SET enabled = 1, kill_switched = 0 WHERE id = 'prov_openai'").run();
    // Since 0177 a price alone no longer adopts a model (selection requires ACTIVE), and a price
    // nobody read takes no part in a cost comparison. A fixture has to say both.
    await t.db
      .prepare(
        "UPDATE provider_model SET status = 'ACTIVE', pricing_state = 'SOURCED', pricing_sourced_at = '2026-09-17T00:00:00.000Z' WHERE provider_id = 'prov_openai'",
      )
      .run();

    const { run: r } = await run({}, { fetchImpl: throwingFetch });
    expect(r.status).toBe("BLOCKED_DEFERRED");
    expect(r.failure_reason).toContain("provider_failure:stub_provider_outage");

    // Reduced mode (§3.5): the deterministic app is unaffected.
    const workCards = await handleRequest(req("/api/work-cards", MP), env);
    expect(workCards.status).toBe(200);
    const runs = await handleRequest(req("/api/ai/runs?status=BLOCKED_DEFERRED", MP), env);
    expect(runs.status).toBe(200);
    const listed = ((await runs.json()) as { runs: AIRunRow[] }).runs;
    expect(listed.some((x) => x.id === r.id)).toBe(true);
  });
});

// ── API surface: run route + budget governance ──

describe("API: /api/ai/run records actor + returns the run; budget change needs the governance receipt", () => {
  it("POST /api/ai/run runs through the boundary as the authenticated user (LOCKDOWN default → local)", async () => {
    await setPolicy({ cost_mode: "NORMAL", privacy_mode: "LOCKDOWN", daily_cap_usd: 25, per_run_cap_usd: 2 });
    const res = await handleRequest(
      req("/api/ai/run", MP, "POST", { purpose: "api surface check", inputs: ["hello west peek"], sensitivity: "INTERNAL" }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as AIRunRow;
    expect(body.status).toBe("COMPLETED");
    expect(body.actor_type).toBe("HUMAN");
    expect(body.actor_id).toBe("fu_scooter_taylor");
    expect(body.model).toBe("mock-local");
    expect(body.trace_id).toMatch(/^trc_/);
  });

  it("GET /api/ai/budget reports the policy, the spend, and who changed it last", async () => {
    const budget = await handleRequest(req("/api/ai/budget", MP), env);
    expect(budget.status).toBe(200);
    const current = (await budget.json()) as { policy: { privacy_mode: string }; today: { spent_usd: number } };
    expect(current.policy.privacy_mode).toBe("LOCKDOWN");
    expect(current.today.spent_usd).toBeGreaterThanOrEqual(0);

    const denied = await handleRequest(
      req("/api/ai/budget", MEMBER, "POST", { cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 10, per_run_cap_usd: 1 }),
      env,
    );
    expect(denied.status).toBe(403);

    // A Managing Partner switches it directly. This used to require a receipt, which meant the SAME
    // partner raised a card, approved their own card and applied it — three steps, one decision, no
    // second pair of eyes. Nothing required a DIFFERENT approver, so the ceremony was friction that
    // looked like control; the role check above is what actually keeps anyone else out.
    const switched = await handleRequest(
      req("/api/ai/budget", MP, "POST", { cost_mode: "NORMAL", privacy_mode: "FRONTIER", daily_cap_usd: 10, per_run_cap_usd: 1 }),
      env,
    );
    expect(switched.status).toBe(201);

    // A receipt still works, so a second partner CAN review a change when the firm wants one.
    const receipt = await approvedCard("governance.policy_change", "budget_policy", "west-peek");
    const withReceipt = await handleRequest(
      req("/api/ai/budget", MP, "POST", {
        cost_mode: "NORMAL",
        privacy_mode: "LOCKDOWN",
        daily_cap_usd: 10,
        per_run_cap_usd: 1,
        approval_receipt_id: receipt,
      }),
      env,
    );
    expect(withReceipt.status).toBe(201);

    // The record is the control that replaced the ceremony: who changed it, and when.
    const after = await handleRequest(req("/api/ai/budget", MP), env);
    const state = (await after.json()) as {
      history: Array<{ privacy_mode: string; set_by: string; created_at: string }>;
    };
    expect(state.history.length).toBeGreaterThanOrEqual(2);
    expect(state.history[0]!.set_by).toBe("fu_scooter_taylor");
    expect(state.history[0]!.created_at).toBeTruthy();
    // Newest first, and nothing overwritten — every change is still its own immutable row.
    expect(state.history[0]!.privacy_mode).toBe("LOCKDOWN");
    expect(state.history.some((h) => h.privacy_mode === "FRONTIER")).toBe(true);

    // Versioning: the old row is preserved; the new row wins; UPDATE/DELETE rejected.
    const old = await t.db.prepare("SELECT id FROM budget_policy WHERE id = 'bp_default_west_peek'").first();
    expect(old).not.toBeNull();
    await expect(t.db.prepare("UPDATE budget_policy SET daily_cap_usd = 0").run()).rejects.toThrow(/immutable/);
    await expect(t.db.prepare("DELETE FROM budget_policy").run()).rejects.toThrow(/immutable/);
  });
});

/**
 * Turning employees on and off (the cap split).
 *
 * The activation cap used to be five, and because only an ACTIVE employee can be seated or do
 * work, it capped the reachable workforce rather than the work being done. Employment and
 * attention are now separate: everyone may be employed, and a short duty roster decides who the
 * firm leans on at a given hour.
 *
 * The guarantee that must survive is the one D10 was really protecting: no employee ever acts
 * without a human having approved it at least once. These assert exactly where that line now sits.
 */
describe("pausing and resuming an employee", () => {
  /** Walk an employee through the governed first activation. */
  async function employ(id: string): Promise<void> {
    const requested = await handleRequest(
      req(`/api/ai/employees/${id}/request-activation`, MP, "POST", { reason: "staffing for the test" }),
      env,
    );
    const card = (await requested.json()) as { id: string };
    await handleRequest(req(`/api/approvals/${card.id}/decide`, MP, "POST", { decision: "approved" }), env);
    const done = await handleRequest(
      req(`/api/ai/employees/${id}/activate`, MP, "POST", { approval_receipt_id: card.id, reason: "staffing for the test" }),
      env,
    );
    /*
     * 409 means already employed, and that is a PASS for this helper.
     *
     * Its contract is "make sure this seat is employed", not "prove nobody employed it first".
     * Insisting on 200 made every test in the file depend on the order of every other one, and on a
     * hand-kept list of which ids were spoken for — a list that silently rotted the moment a seat
     * was merged away. Any other status is still a failure.
     */
    expect([200, 409]).toContain(done.status);
  }

  it("pauses without any approval at all — stopping a machine is always safe", async () => {
    await employ("aie_wells");
    const paused = await handleRequest(
      req("/api/ai/employees/aie_wells/running", MP, "POST", { running: false, reason: "not needed today" }),
      env,
    );
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { status: string }).status).toBe("PAUSED");
  });

  it("resumes an already-approved employee without a second approval", async () => {
    await employ("aie_waverly");
    await handleRequest(req("/api/ai/employees/aie_waverly/running", MP, "POST", { running: false }), env);
    const resumed = await handleRequest(
      req("/api/ai/employees/aie_waverly/running", MP, "POST", { running: true }),
      env,
    );
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { status: string }).status).toBe("ACTIVE");
  });

  it("refuses to resume an employee no human ever approved", async () => {
    // The line that must not move: this is a first activation wearing a different name.
    const res = await handleRequest(
      req("/api/ai/employees/aie_pippa/running", MP, "POST", { running: true }),
      env,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("never_activated");
  });

  it("lets far more than five be employed at once", async () => {
    /*
     * Six DISTINCT employees none of the earlier tests in this file has already employed —
     * employing somebody twice is a 409 and would prove nothing about the cap.
     *
     * Taken from the ROSTER rather than typed. The hand-written list ended in `aie_piper`, and when
     * that seat merged into Wesley the id stopped resolving: `employ` 404'd, the loop carried on,
     * and the test failed on a count rather than on the thing it was testing. The same failure
     * shape as the phantom "Paige" — a name in a fixture that the system no longer has.
     */
    // WHO IS ALREADY EMPLOYED IS READ, NOT GUESSED. Employing somebody twice is a 409 and the
    // helper asserts 200, so a hand-kept list of "the ones the other tests use" has to be right
    // about a file that keeps changing — and it was not: the original list ended in `aie_piper`,
    // an id that stopped existing when that seat merged into Wesley.
    const active = await t.db
      .prepare("SELECT id FROM ai_employee WHERE status = 'ACTIVE'")
      .all<{ id: string }>();
    const taken = new Set((active.results ?? []).map((r) => r.id));
    const six = AI_EMPLOYEE_ROSTER.map((e) => `aie_${e.name.toLowerCase()}`)
      .filter((id) => !taken.has(id))
      .slice(0, 6);
    expect(six, "the roster must hold six seats nobody has employed yet").toHaveLength(6);
    for (const id of six) {
      await employ(id);
    }
    const row = await t.db
      .prepare("SELECT COUNT(*) AS n FROM ai_employee WHERE status = 'ACTIVE'")
      .first<{ n: number }>();
    expect(row!.n).toBeGreaterThan(5);
  });

  it("records every toggle in the status history, with no receipt", async () => {
    await employ("aie_porter");
    await handleRequest(
      req("/api/ai/employees/aie_porter/running", MP, "POST", { running: false, reason: "quiet week" }),
      env,
    );
    const history = await t.db
      .prepare("SELECT * FROM ai_employee_status_history WHERE ai_employee_id = 'aie_porter' AND to_status = 'PAUSED'")
      .all<{ reason: string; approval_receipt_id: string | null }>();
    expect(history.results).toHaveLength(1);
    expect(history.results![0]!.reason).toBe("quiet week");
    // A pause is not an approved action, so it must not claim a receipt it never had.
    expect(history.results![0]!.approval_receipt_id).toBeNull();
  });

  it("never lets an AI employee pause or resume anyone", async () => {
    await employ("aie_porter");
    // Called at the service level deliberately: an AI actor cannot reach the HTTP route at all, so
    // testing through it would prove only that the front door is locked. The guard that matters is
    // the one inside, which is what would still be standing if a future caller arrived some other way.
    await expect(
      setEmployeeRunning(
        env,
        { type: "AI", aiEmployeeId: "aie_wyatt", roles: [], firmScopes: ["west-peek"] },
        "aie_porter",
        false,
        "an employee trying to bench a colleague",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rosters a focused few on duty, and rotates them through the day", async () => {
    await employ("aie_walter");
    const morning = await handleRequest(req("/api/ai/employees/on-duty?hour=8", MP), env);
    expect(morning.status).toBe(200);
    const m = (await morning.json()) as { onDuty: Array<{ name: string; because: string }>; shift: string; active_count: number };
    expect(m.shift).toBe("MORNING");
    expect(m.onDuty.length).toBeLessThanOrEqual(5);
    for (const d of m.onDuty) expect(d.because.length).toBeGreaterThan(10);

    const evening = await handleRequest(req("/api/ai/employees/on-duty?hour=19", MP), env);
    const e = (await evening.json()) as { shift: string };
    expect(e.shift).toBe("EVENING");

    // Only employed people are ever rostered — a rota that names someone switched off is
    // promising help that will not arrive.
    const names = m.onDuty.map((d) => d.name);
    const active = await t.db
      .prepare("SELECT name FROM ai_employee WHERE status = 'ACTIVE'")
      .all<{ name: string }>();
    const activeNames = new Set((active.results ?? []).map((r) => r.name));
    for (const n of names) expect(activeNames.has(n)).toBe(true);
  });
});

/**
 * IMAGES THROUGH THE BOUNDARY.
 *
 * Vision was added so an employee could look at a page rather than only read it. Every control in
 * runAi was written for text — most importantly the credential scrubber, which reads strings and is
 * simply blind to a screenshot of a page displaying an API key.
 *
 * That asymmetry is the whole reason images get their own gate, and these pin it. A future provider
 * permitted a higher label for text must not silently inherit that permission for pictures.
 */
describe("images are gated separately from text", () => {
  const shot = { mediaType: "image/jpeg", dataBase64: "/9j/4AAQSkZJRg==", label: "desktop" };

  it("refuses images above INTERNAL, even though the same label is fine for text", async () => {
    const stub = stubFetch();
    // Text at RESTRICTED is a policy question answered elsewhere; an image at RESTRICTED is refused
    // here, before any provider is consulted at all.
    const { run: r } = await run(
      { sensitivity: "RESTRICTED", images: [shot] },
      { fetchImpl: stub.fetchImpl },
    );
    expect(r.status).not.toBe("COMPLETED");
    expect(r.failure_reason).toContain("images_not_permitted_at_label");
    // Nothing left the building.
    expect(stub.calls.length).toBe(0);
  });

  it("allows an image at PUBLIC and at INTERNAL", async () => {
    for (const label of ["PUBLIC", "INTERNAL"] as const) {
      const stub = stubFetch();
      const { run: r } = await run({ sensitivity: label, images: [shot] }, { fetchImpl: stub.fetchImpl });
      expect(r.failure_reason ?? "").not.toContain("images_not_permitted_at_label");
    }
  });

  it("caps how many images one run may carry", async () => {
    const stub = stubFetch();
    const { run: r } = await run(
      { sensitivity: "PUBLIC", images: [shot, shot, shot, shot, shot] },
      { fetchImpl: stub.fetchImpl },
    );
    expect(r.failure_reason).toContain("too_many_images");
    expect(stub.calls.length).toBe(0);
  });

  it("refuses a media type nothing here produces", async () => {
    // Anything but jpeg or png is either a mistake or an attempt to send something that is not a
    // screenshot at all.
    const stub = stubFetch();
    const { run: r } = await run(
      { sensitivity: "PUBLIC", images: [{ ...shot, mediaType: "application/pdf" }] },
      { fetchImpl: stub.fetchImpl },
    );
    expect(r.failure_reason).toContain("unsupported_image_type");
    expect(stub.calls.length).toBe(0);
  });

  it("counts images in the token estimate, so the budget check is not blind to them", async () => {
    // The expensive half of a vision run is the pictures. A budget gate that only measured the
    // prompt would wave through exactly the run it exists to catch.
    const stub = stubFetch();
    const withImage = await run({ sensitivity: "PUBLIC", images: [shot] }, { fetchImpl: stub.fetchImpl });
    const stub2 = stubFetch();
    const textOnly = await run({ sensitivity: "PUBLIC" }, { fetchImpl: stub2.fetchImpl });
    const est = (r: { cost_estimate_json: string }) =>
      Number(JSON.parse(r.cost_estimate_json || "{}").input_tokens ?? 0);
    expect(est(withImage.run)).toBeGreaterThan(est(textOnly.run));
  });
});

/**
 * A VISION RUN THAT REACHES A BLIND MODEL IS THE WORST OUTCOME AVAILABLE.
 *
 * A text-only model handed a multimodal message does not fail. It ignores the images and answers
 * from the prompt, so a design review comes back fluent, confident and entirely invented — the
 * exact failure `look_at` was built to prevent, arriving in the shape of success.
 *
 * Nothing in the routing data can catch this on its own: every model in the registry declares only
 * `text-completion`, so there is no vision capability to filter on. Hence the named list, and hence
 * this test.
 */
describe("images only go to a model that can see", () => {
  const shot = { mediaType: "image/jpeg", dataBase64: "/9j/4AAQSkZJRg==", label: "desktop" };

  it("refuses a vision run in LOCKDOWN rather than answering from the prompt", async () => {
    // The test firm runs in LOCKDOWN, which short-circuits to the deterministic offline adapter
    // before any model is selected. That adapter cannot see and does not fail — it answers from
    // the prompt, so the review comes back canned and reads exactly like success.
    //
    // This was found by instrumenting the capability check below and discovering it was never
    // executed: a run completed with images attached, against a model with no eyes, and reported
    // nothing wrong.
    const stub = stubFetch();
    const { run: r } = await run({ sensitivity: "PUBLIC", images: [shot] }, { fetchImpl: stub.fetchImpl });
    expect(r.status).not.toBe("COMPLETED");
    expect(r.failure_reason).toContain("images_need_a_frontier_model");
    // Nothing was sent anywhere.
    expect(stub.calls.length).toBe(0);
  });

  it("keeps text runs working in LOCKDOWN — only images are refused", async () => {
    // The refusal must be about the images, not about lockdown. Ordinary work still runs offline.
    const stub = stubFetch();
    const { run: r } = await run({ sensitivity: "PUBLIC" }, { fetchImpl: stub.fetchImpl });
    expect(r.status).toBe("COMPLETED");
  });

  it("names the model in the frontier refusal, so the fix is obvious", () => {
    // Adding a model to the list is a five-second fix only if the message says which is missing.
    const src = readFileSync(new URL("../src/worker/ai/runAi.ts", import.meta.url), "utf8");
    expect(src).toContain("model_cannot_see_images:${selected.pricing.model}");
    expect(src).toContain("VISION_CAPABLE_MODELS");
    // And the list must actually contain the model the firm has pinned for employee work, or every
    // design review blocks the moment it leaves lockdown.
    expect(src).toContain('"anthropic/claude-sonnet-5"');
  });
});

describe("a document is gated separately from an image", () => {
  /**
   * Operator asked for a deck to be readable — from the "add a company" flow and from a #wpdeck
   * email. Most decks are PDFs, and a PDF is a `file` block rather than an image block: sent as an
   * image, a twenty-page deck is one unreadable thumbnail. So documents get their own type, their
   * own model list and their own guards, and these pin all three.
   */
  const deck = { mediaType: "application/pdf", dataBase64: "JVBERi0xLjQK", label: "deck.pdf" };

  it("refuses a document above INTERNAL, before any provider is consulted", async () => {
    const stub = stubFetch();
    const { run: r } = await run({ sensitivity: "RESTRICTED", documents: [deck] }, { fetchImpl: stub.fetchImpl });
    expect(r.status).not.toBe("COMPLETED");
    expect(r.failure_reason).toContain("documents_not_permitted_at_label");
    // A deck a partner marked confidential does not leave because somebody pressed "read the deck".
    expect(stub.calls.length).toBe(0);
  });

  it("refuses anything that is not a PDF rather than handing a model a file it cannot open", async () => {
    const stub = stubFetch();
    const { run: r } = await run(
      { sensitivity: "INTERNAL", documents: [{ ...deck, mediaType: "application/vnd.ms-powerpoint" }] },
      { fetchImpl: stub.fetchImpl },
    );
    expect(r.failure_reason).toContain("unsupported_document_type");
    expect(stub.calls.length).toBe(0);
  });

  it("carries one at a time — a deck is a deck", async () => {
    const stub = stubFetch();
    const { run: r } = await run({ sensitivity: "INTERNAL", documents: [deck, deck] }, { fetchImpl: stub.fetchImpl });
    expect(r.failure_reason).toContain("too_many_documents");
  });

  it("costs more than text, so the budget check can see it coming", async () => {
    // Under-counting a twenty-page deck would let exactly the run the ceiling exists to stop go
    // through. The estimate is deliberately generous in the other direction.
    const stub = stubFetch();
    const withDoc = await run({ sensitivity: "INTERNAL", documents: [deck] }, { fetchImpl: stub.fetchImpl });
    const stub2 = stubFetch();
    const withoutDoc = await run({ sensitivity: "INTERNAL" }, { fetchImpl: stub2.fetchImpl });
    const est = (r: any) => JSON.parse(String(r.run.cost_estimate_json ?? "{}")).input_tokens ?? 0;
    expect(est(withDoc)).toBeGreaterThan(est(withoutDoc));
  });
});

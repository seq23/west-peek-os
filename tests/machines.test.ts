import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi } from "../src/worker/ai/runAi";
import { isMachinePaused } from "../src/worker/services/machines";

/**
 * P17 — Machine Control Center + Capability Intelligence (GAP-06, GAP-07).
 *
 * Rules under test:
 * - All 45 registry machines appear with real operating state, queue, spend, and failures.
 * - PAUSE HAS TEETH, in two independent places: capture routing refuses a paused machine
 *   (409 machine_paused) and `run_ai` refuses to spend anything attributed to it. Neither
 *   is UI hiding; both are checked in the service.
 * - Configuration changes append to the machine's own operating memory, which is append-only.
 * - A machine cannot depend on itself, and dependency targets must exist.
 * - Capability `maturity` and `tested_state` stay separate; an UNTESTED capability cannot be
 *   made ACTIVE, and PROVEN_LIVE cannot be recorded while no live provider access exists.
 * - The recommended stack is arithmetic over recorded after-action outcomes and says so.
 * - A BUY decision must name a vendor; build-vs-buy decisions are human-only and append-only.
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

let seq = 0;
async function makeCapture(): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/captures", MP, "POST", {
    capture_type: "note",
    raw_text: `P17 capture ${seq}`,
    source_channel: "web",
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the control center makes the 45-machine registry operable", () => {
  it("returns every machine with operating state, queue, spend, and failure counts", async () => {
    const res = await call<{ machines: any[]; note: string }>("/api/machines/control-center", MP);
    expect(res.status).toBe(200);
    expect(res.body.machines).toHaveLength(45);
    expect(res.body.note).toContain("cannot spend AI budget");

    const research = res.body.machines.find((m: any) => m.key === "research_intelligence")!;
    expect(research.status).toBe("ACTIVE");
    expect(research.priority).toBe("NORMAL");
    expect(Array.isArray(research.queue)).toBe(true);
    expect(typeof research.spend_30d_usd).toBe("number");
    expect(typeof research.failures_30d).toBe("number");
  });

  it("records configuration changes into the machine's own operating memory", async () => {
    const res = await call<{ priority: string; sla_target: string }>("/api/machines/23/state", MP, "PATCH", {
      priority: "HIGH",
      sla_target: "research packets within 2 business days",
      allowed_tools: ["web_read", "document_read"],
      data_access: ["PUBLIC", "INTERNAL"],
      evidence_expectation: "every claim carries a source",
      owner_firm_user_id: "fu_scooter_taylor",
    });
    expect(res.status).toBe(200);
    expect(res.body.priority).toBe("HIGH");

    const detail = await call<{ memory: Array<{ kind: string; body: string }> }>("/api/machines/23/state", MP);
    expect(detail.body.memory[0]!.kind).toBe("CONFIG_CHANGE");
    expect(detail.body.memory[0]!.body).toContain("priority");
  });

  it("keeps machine memory append-only", async () => {
    const added = await call<{ id: string }>("/api/machines/23/memory", MP, "POST", {
      kind: "LESSON",
      body: "Source-quality checks belong before synthesis, not after.",
    });
    expect(added.status).toBe(201);
    await expect(t.db.prepare("UPDATE machine_memory SET body = 'x' WHERE id = ?1").bind(added.body.id).run()).rejects.toThrow(/append-only/);
    await expect(t.db.prepare("DELETE FROM machine_memory WHERE id = ?1").bind(added.body.id).run()).rejects.toThrow(/append-only/);
  });

  it("refuses a self-dependency and an unknown dependency target", async () => {
    const self = await call("/api/machines/23/dependencies", MP, "POST", { depends_on_machine_id: 23 });
    expect(self.status).toBe(400);
    const missing = await call("/api/machines/23/dependencies", MP, "POST", { depends_on_machine_id: 999 });
    expect(missing.status).toBe(404);
    const ok = await call("/api/machines/23/dependencies", MP, "POST", { depends_on_machine_id: 25, kind: "DATA", note: "resolver first" });
    expect(ok.status).toBe(201);
  });
});

describe("pause has teeth in both enforcement points", () => {
  it("pauses a machine, records the change, and refuses a redundant pause", async () => {
    const paused = await call<{ status: string; pause_reason: string }>("/api/machines/33/pause", MP, "POST", {
      status: "PAUSED",
      reason: "content machine on hold during the rebrand",
    });
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe("PAUSED");
    expect(paused.body.pause_reason).toContain("rebrand");

    const again = await call("/api/machines/33/pause", MP, "POST", { status: "PAUSED", reason: "again" });
    expect(again.status).toBe(409);

    const change = await t.db
      .prepare("SELECT * FROM machine_state_change WHERE machine_id = 33 ORDER BY created_at DESC LIMIT 1")
      .first<{ from_status: string; to_status: string }>();
    expect(change!.from_status).toBe("ACTIVE");
    expect(change!.to_status).toBe("PAUSED");
  });

  it("refuses to route a capture to a paused machine (409, by name)", async () => {
    const captureId = await makeCapture();
    const routed = await call<{ error: string; detail: string }>(`/api/captures/${captureId}/route`, MP, "POST", { machine_id: 33 });
    expect(routed.status).toBe(409);
    expect(routed.body.error).toBe("machine_paused");
    expect(routed.body.detail).toContain("rebrand");
  });

  it("refuses to spend ANY AI budget on a paused machine", async () => {
    const { run } = await runAi(env, {
      purpose: "work for a paused machine",
      actor: MP_ACTOR,
      inputs: ["do something"],
      sensitivity: "INTERNAL",
      routing: { machineId: 33 },
    });
    expect(run.status).toBe("PREFLIGHT_BLOCKED");
    expect(run.failure_reason).toContain("machine_paused:33");
    // Blocked runs cost nothing, and the attribution still records which machine caused it.
    const attribution = await t.db.prepare("SELECT machine_id FROM ai_run_attribution WHERE ai_run_id = ?1").bind(run.id).first<{ machine_id: number }>();
    expect(attribution!.machine_id).toBe(33);
  });

  it("resuming restores both paths", async () => {
    const resumed = await call<{ status: string }>("/api/machines/33/pause", MP, "POST", { status: "ACTIVE", reason: "rebrand finished" });
    expect(resumed.body.status).toBe("ACTIVE");
    expect((await isMachinePaused(env, 33)).paused).toBe(false);

    const captureId = await makeCapture();
    const routed = await call(`/api/captures/${captureId}/route`, MP, "POST", { machine_id: 33 });
    expect(routed.status).toBe(200);
  });
});

describe("capabilities keep design maturity and proof separate", () => {
  it("registers a capability on the bench with its dependencies", async () => {
    const res = await call<{ id: string; state: string; tested_state: string }>("/api/capabilities", MP, "POST", {
      capability_key: "secondary_block_pricing",
      name: "Secondary block pricing comparison",
      description: "Compare an offered block against the last primary and recent observations.",
      maturity: "DEVELOPING",
      confidence: "MEDIUM",
      tested_state: "FIXTURE_TESTED",
      model_dependencies: ["gpt-4o-mini"],
      tool_dependencies: ["deal_math"],
      cost_estimate_usd: 0.35,
      cost_basis: "median of 12 recorded deal-math runs",
    });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("BENCH");
    expect(res.body.tested_state).toBe("FIXTURE_TESTED");
  });

  it("refuses PROVEN_LIVE while no live provider access exists", async () => {
    const res = await call("/api/capabilities", MP, "POST", {
      capability_key: "live_claim",
      name: "Something allegedly proven live",
      tested_state: "PROVEN_LIVE",
    });
    expect(res.status).toBe(409);
    expect((res.body as any).error).toBe("live_proof_unavailable");
  });

  it("refuses a cost estimate with no stated basis", async () => {
    const res = await call("/api/capabilities", MP, "POST", {
      capability_key: "unbased_cost",
      name: "Costed guess",
      cost_estimate_usd: 5,
    });
    expect(res.status).toBe(400);
    expect((res.body as any).error).toBe("cost_basis_required");
  });

  it("refuses to make an UNTESTED capability ACTIVE", async () => {
    const created = await call<{ id: string }>("/api/capabilities", MP, "POST", {
      capability_key: "untested_thing",
      name: "Untested thing",
    });
    const res = await call(`/api/capabilities/${created.body.id}/state`, MP, "POST", { state: "ACTIVE", reason: "looks fine" });
    expect(res.status).toBe(409);
    expect((res.body as any).error).toBe("untested_capability");
  });

  it("assigns to employees and machines, and refuses a target that does not exist", async () => {
    const list = await call<{ capabilities: any[] }>("/api/capabilities", MP);
    const cap = list.body.capabilities.find((c: any) => c.capability_key === "secondary_block_pricing")!;

    const toEmployee = await call(`/api/capabilities/${cap.id}/assignments`, MP, "POST", { target_kind: "EMPLOYEE", target_id: "aie_priya" });
    expect(toEmployee.status).toBe(201);
    const toMachine = await call(`/api/capabilities/${cap.id}/assignments`, MP, "POST", { target_kind: "MACHINE", target_id: "19" });
    expect(toMachine.status).toBe(201);
    const bad = await call(`/api/capabilities/${cap.id}/assignments`, MP, "POST", { target_kind: "EMPLOYEE", target_id: "aie_ghost" });
    expect(bad.status).toBe(404);
  });

  it("builds the recommended stack from recorded outcomes only, and says so", async () => {
    const list = await call<{ capabilities: any[] }>("/api/capabilities", MP);
    const cap = list.body.capabilities.find((c: any) => c.capability_key === "secondary_block_pricing")!;

    await call(`/api/capabilities/${cap.id}/after-actions`, MP, "POST", { outcome: "SUCCESS", note: "priced a block correctly", cost_usd: 0.3 });
    await call(`/api/capabilities/${cap.id}/after-actions`, MP, "POST", { outcome: "SUCCESS", note: "second clean run", cost_usd: 0.28 });
    await call(`/api/capabilities/${cap.id}/after-actions`, MP, "POST", { outcome: "FAILURE", note: "missing observations", cost_usd: 0.1 });

    // Bench capabilities are excluded from the stack until the operator makes them ACTIVE.
    const benchStack = await call<{ recommended_stack: any[] }>("/api/capabilities", MP);
    expect(benchStack.body.recommended_stack.find((r: any) => r.capability_key === "secondary_block_pricing")).toBeUndefined();

    const activated = await call(`/api/capabilities/${cap.id}/state`, MP, "POST", { state: "ACTIVE", reason: "fixture-tested and in use" });
    expect(activated.status).toBe(200);

    const after = await call<{ recommended_stack: any[]; capabilities: any[]; definitions: Record<string, string> }>("/api/capabilities", MP);
    const entry = after.body.recommended_stack.find((r: any) => r.capability_key === "secondary_block_pricing")!;
    expect(entry.success_rate).toBeCloseTo(66.7, 0);
    expect(entry.sample_size).toBe(3);
    expect(entry.why).toContain("recorded use");
    expect(after.body.definitions.recommended_stack).toContain("not a model opinion");

    const enriched = after.body.capabilities.find((c: any) => c.capability_key === "secondary_block_pricing")!;
    expect(enriched.observed_cost_usd).toBeCloseTo(0.68, 5);
  });

  it("reports a null success rate rather than assuming success with no evidence", async () => {
    const res = await call<{ capabilities: any[] }>("/api/capabilities", MP);
    const untested = res.body.capabilities.find((c: any) => c.capability_key === "untested_thing")!;
    expect(untested.success_rate).toBeNull();
    expect(untested.after_action_count).toBe(0);
  });

  it("requires a vendor on a BUY decision and keeps decisions append-only", async () => {
    const list = await call<{ capabilities: any[] }>("/api/capabilities", MP);
    const cap = list.body.capabilities.find((c: any) => c.capability_key === "secondary_block_pricing")!;

    const noVendor = await call(`/api/capabilities/${cap.id}/build-vs-buy`, MP, "POST", { decision: "BUY", rationale: "cheaper" });
    expect(noVendor.status).toBe(400);

    const decided = await call<{ id: string; decision: string }>(`/api/capabilities/${cap.id}/build-vs-buy`, MP, "POST", {
      decision: "BUILD",
      rationale: "the comparison depends on our own observation history",
      cost_estimate_usd: 4000,
    });
    expect(decided.status).toBe(201);
    await expect(t.db.prepare("UPDATE build_vs_buy_decision SET decision = 'BUY' WHERE id = ?1").bind(decided.body.id).run()).rejects.toThrow(/append-only/);
  });

  it("keeps after-action records append-only", async () => {
    const row = await t.db.prepare("SELECT id FROM capability_after_action LIMIT 1").first<{ id: string }>();
    await expect(t.db.prepare("UPDATE capability_after_action SET outcome = 'SUCCESS' WHERE id = ?1").bind(row!.id).run()).rejects.toThrow(/append-only/);
  });
});

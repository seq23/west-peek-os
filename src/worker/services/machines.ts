import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";

/**
 * Machine Control Center (P17, GAP-06).
 *
 * The 45-machine registry becomes operable: owner, SLA, priority, tools, data access, evidence
 * expectation, dependencies, memory, assigned employees, live queue, spend, and failures.
 *
 * PAUSE HAS TEETH. A paused machine is refused work in two independent places:
 *   1. `isMachinePaused` is consulted by capture routing (`services/captures.ts`), so no new
 *      work card can be routed to it;
 *   2. the same check runs inside the `run_ai` boundary, so no AI spend can be attributed to it.
 * Neither is UI hiding, and neither can be bypassed by calling the API directly.
 */

export class MachineError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof MachineError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** THE pause check. Anything that gives a machine work must call this first. */
export async function isMachinePaused(env: Env, machineId: number): Promise<{ paused: boolean; reason: string | null }> {
  const row = await env.WP_OS_DB.prepare("SELECT status, pause_reason FROM machine_state WHERE machine_id = ?1")
    .bind(machineId)
    .first<{ status: string; pause_reason: string | null }>();
  if (!row) return { paused: false, reason: null };
  return { paused: row.status === "PAUSED", reason: row.pause_reason };
}

function costOfRun(row: { cost_estimate_json: string; actual_usage_json: string | null }): number {
  try {
    if (row.actual_usage_json) return (JSON.parse(row.actual_usage_json) as { cost_usd?: number }).cost_usd ?? 0;
    return (JSON.parse(row.cost_estimate_json) as { estimated_cost_usd?: number }).estimated_cost_usd ?? 0;
  } catch {
    return 0;
  }
}

export async function handleMachineControlCenter(ctx: RouteContext): Promise<Response> {
  const machines = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT m.id, m.key, m.name, m.domain_id, m.purpose, m.in_initial_scope,
              s.owner_firm_user_id, s.status, s.priority, s.sla_target, s.allowed_tools_json,
              s.data_access_json, s.evidence_expectation, s.pause_reason, s.updated_at
         FROM machine m
         LEFT JOIN machine_state s ON s.machine_id = m.id
        ORDER BY m.id`,
    ).all<Record<string, unknown>>()
  ).results ?? [];

  const assignments = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT a.machine_id, e.id AS employee_id, e.name, e.status
         FROM ai_employee_assignment a JOIN ai_employee e ON e.id = a.ai_employee_id
        WHERE a.active = 1`,
    ).all<{ machine_id: number; employee_id: string; name: string; status: string }>()
  ).results ?? [];

  const queue = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT machine_id, id, title, state, priority FROM work_card
        WHERE machine_id IS NOT NULL AND state IN ('OPEN','IN_PROGRESS','BLOCKED')
        ORDER BY created_at DESC`,
    ).all<{ machine_id: number; id: string; title: string; state: string; priority: string }>()
  ).results ?? [];

  const runs = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT a.machine_id, r.id, r.status, r.purpose, r.failure_reason, r.created_at,
              r.cost_estimate_json, r.actual_usage_json
         FROM ai_run_attribution a JOIN ai_run r ON r.id = a.ai_run_id
        WHERE a.machine_id IS NOT NULL AND r.created_at >= date('now', '-30 days')`,
    ).all<{
      machine_id: number;
      id: string;
      status: string;
      purpose: string;
      failure_reason: string | null;
      created_at: string;
      cost_estimate_json: string;
      actual_usage_json: string | null;
    }>()
  ).results ?? [];

  const deps = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_dependency").all<{ machine_id: number; depends_on_machine_id: number; kind: string }>()
  ).results ?? [];

  const capabilities = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT a.target_id, c.capability_key, c.name, c.state, c.tested_state
         FROM capability_assignment a JOIN capability c ON c.id = a.capability_id
        WHERE a.target_kind = 'MACHINE' AND a.active = 1`,
    ).all<{ target_id: string; capability_key: string; name: string; state: string; tested_state: string }>()
  ).results ?? [];

  const modelPolicies = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_model_policy").all<{ machine_id: number; preferred_provider_key: string | null; preferred_model: string | null; max_data_class: string }>()
  ).results ?? [];

  return json({
    machines: machines.map((m) => {
      const id = m.id as number;
      const myRuns = runs.filter((r) => r.machine_id === id);
      const failures = myRuns.filter((r) => r.status !== "COMPLETED");
      return {
        ...m,
        employees: assignments.filter((a) => a.machine_id === id).map((a) => ({ id: a.employee_id, name: a.name, status: a.status })),
        queue: queue.filter((q) => q.machine_id === id).map((q) => ({ id: q.id, title: q.title, state: q.state, priority: q.priority })),
        runs_30d: myRuns.length,
        failures_30d: failures.length,
        spend_30d_usd: Math.round(myRuns.reduce((sum, r) => sum + costOfRun(r), 0) * 1_000_000) / 1_000_000,
        recent_failures: failures.slice(0, 3).map((f) => ({ id: f.id, reason: f.failure_reason ?? f.status, at: f.created_at })),
        depends_on: deps.filter((d) => d.machine_id === id).map((d) => ({ machine_id: d.depends_on_machine_id, kind: d.kind })),
        capabilities: capabilities.filter((c) => c.target_id === String(id)),
        model_policy: modelPolicies.find((p) => p.machine_id === id) ?? null,
      };
    }),
    note: "A PAUSED machine is refused new work routing and cannot spend AI budget. The pause is enforced in the services, not by hiding the surface.",
  });
}

export async function handleGetMachine(ctx: RouteContext): Promise<Response> {
  const machineId = Number(ctx.params.id!);
  const machine = await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine WHERE id = ?1").bind(machineId).first();
  if (!machine) return json({ error: "not_found" }, { status: 404 });
  const state = await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_state WHERE machine_id = ?1").bind(machineId).first();
  const memory = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_memory WHERE machine_id = ?1 ORDER BY created_at DESC LIMIT 50").bind(machineId).all()
  ).results ?? [];
  const changes = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_state_change WHERE machine_id = ?1 ORDER BY created_at DESC LIMIT 50").bind(machineId).all()
  ).results ?? [];
  const deps = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT d.*, m.name AS depends_on_name FROM machine_dependency d JOIN machine m ON m.id = d.depends_on_machine_id WHERE d.machine_id = ?1`,
    )
      .bind(machineId)
      .all()
  ).results ?? [];
  return json({ machine, state, memory, state_changes: changes, dependencies: deps });
}

const configureSchema = z.object({
  owner_firm_user_id: z.string().trim().min(1).nullable().optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).optional(),
  sla_target: z.string().trim().optional(),
  allowed_tools: z.array(z.string().trim().min(1)).optional(),
  data_access: z.array(z.string().trim().min(1)).optional(),
  evidence_expectation: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

export async function handleConfigureMachine(ctx: RouteContext): Promise<Response> {
  const parsed = configureSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "machine configuration is human-reserved" }, { status: 403 });
  const machineId = Number(ctx.params.id!);
  const current = await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_state WHERE machine_id = ?1")
    .bind(machineId)
    .first<{
      owner_firm_user_id: string | null;
      priority: string;
      sla_target: string;
      allowed_tools_json: string;
      data_access_json: string;
      evidence_expectation: string;
      notes: string;
    }>();
  if (!current) return json({ error: "not_found" }, { status: 404 });

  const authz = await authorize(ctx.env, actor, "machine_state.configure", { objectType: "machine", objectId: String(machineId) });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const b = parsed.data;
  await ctx.env.WP_OS_DB.prepare(
    `UPDATE machine_state SET
       owner_firm_user_id = ?2, priority = ?3, sla_target = ?4, allowed_tools_json = ?5,
       data_access_json = ?6, evidence_expectation = ?7, notes = ?8, updated_by = ?9, updated_at = ?10
     WHERE machine_id = ?1`,
  )
    .bind(
      machineId,
      b.owner_firm_user_id !== undefined ? b.owner_firm_user_id : current.owner_firm_user_id,
      b.priority ?? current.priority,
      b.sla_target ?? current.sla_target,
      b.allowed_tools ? JSON.stringify(b.allowed_tools) : current.allowed_tools_json,
      b.data_access ? JSON.stringify(b.data_access) : current.data_access_json,
      b.evidence_expectation ?? current.evidence_expectation,
      b.notes ?? current.notes,
      actor.firmUserId!,
      new Date().toISOString(),
    )
    .run();

  // A configuration change is part of the machine's operating history, not just a row update.
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO machine_memory (id, machine_id, kind, body, author_type, author_id) VALUES (?1, ?2, 'CONFIG_CHANGE', ?3, 'HUMAN', ?4)",
  )
    .bind(
      `mmem_${crypto.randomUUID()}`,
      machineId,
      `Configuration changed: ${Object.keys(b).join(", ") || "no fields"}`,
      actor.firmUserId!,
    )
    .run();

  await appendEvent(ctx.env, {
    eventType: "machine_state.configured",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "machine",
    objectId: String(machineId),
    payload: { fields: Object.keys(b) },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_state WHERE machine_id = ?1").bind(machineId).first());
}

const pauseSchema = z.object({ status: z.enum(["ACTIVE", "PAUSED"]), reason: z.string().trim().min(1) });

export async function handlePauseMachine(ctx: RouteContext): Promise<Response> {
  const parsed = pauseSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "pausing a machine is human-reserved" }, { status: 403 });
  const machineId = Number(ctx.params.id!);
  const current = await ctx.env.WP_OS_DB.prepare("SELECT status FROM machine_state WHERE machine_id = ?1").bind(machineId).first<{ status: string }>();
  if (!current) return json({ error: "not_found" }, { status: 404 });
  if (current.status === parsed.data.status) {
    return json({ error: "already_in_state", detail: `machine is already ${current.status}` }, { status: 409 });
  }

  const authz = await authorize(ctx.env, actor, "machine_state.pause", { objectType: "machine", objectId: String(machineId) });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare(
    `UPDATE machine_state SET status = ?2, paused_by = ?3, paused_at = ?4, pause_reason = ?5, updated_by = ?3, updated_at = ?4 WHERE machine_id = ?1`,
  )
    .bind(
      machineId,
      parsed.data.status,
      actor.firmUserId!,
      now,
      parsed.data.status === "PAUSED" ? parsed.data.reason : null,
    )
    .run();
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO machine_state_change (id, machine_id, from_status, to_status, reason, actor_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(`msc_${crypto.randomUUID()}`, machineId, current.status, parsed.data.status, parsed.data.reason, actor.firmUserId!)
    .run();

  await appendEvent(ctx.env, {
    eventType: parsed.data.status === "PAUSED" ? "machine.paused" : "machine.resumed",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "machine",
    objectId: String(machineId),
    payload: { from: current.status, to: parsed.data.status, reason: parsed.data.reason },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_state WHERE machine_id = ?1").bind(machineId).first());
}

const dependencySchema = z.object({
  depends_on_machine_id: z.number().int().positive(),
  kind: z.enum(["DATA", "APPROVAL", "SCHEDULE", "TOOL"]).default("DATA"),
  note: z.string().trim().default(""),
});

export async function handleDeclareDependency(ctx: RouteContext): Promise<Response> {
  const parsed = dependencySchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const machineId = Number(ctx.params.id!);
  if (machineId === parsed.data.depends_on_machine_id) {
    return json({ error: "invalid_input", detail: "a machine cannot depend on itself" }, { status: 400 });
  }
  const target = await ctx.env.WP_OS_DB.prepare("SELECT id FROM machine WHERE id = ?1").bind(parsed.data.depends_on_machine_id).first();
  if (!target) return json({ error: "machine_not_found" }, { status: 404 });

  const authz = await authorize(ctx.env, actor, "machine_dependency.declare", { objectType: "machine", objectId: String(machineId) });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  await ctx.env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO machine_dependency (id, machine_id, depends_on_machine_id, kind, note, declared_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(`mdep_${crypto.randomUUID()}`, machineId, parsed.data.depends_on_machine_id, parsed.data.kind, parsed.data.note, ctx.identity!.id)
    .run();
  return json({ ok: true }, { status: 201 });
}

const memorySchema = z.object({
  kind: z.enum(["OPERATING_NOTE", "FAILURE", "CONFIG_CHANGE", "LESSON"]),
  body: z.string().trim().min(1),
});

export async function handleAppendMemory(ctx: RouteContext): Promise<Response> {
  const parsed = memorySchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const machineId = Number(ctx.params.id!);
  const machine = await ctx.env.WP_OS_DB.prepare("SELECT id FROM machine WHERE id = ?1").bind(machineId).first();
  if (!machine) return json({ error: "not_found" }, { status: 404 });
  const authz = await authorize(ctx.env, actor, "machine_memory.append", { objectType: "machine", objectId: String(machineId) });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const id = `mmem_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO machine_memory (id, machine_id, kind, body, author_type, author_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(id, machineId, parsed.data.kind, parsed.data.body, actor.type, actor.firmUserId ?? actor.aiEmployeeId ?? "system")
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine_memory WHERE id = ?1").bind(id).first(), { status: 201 });
}

export { errorResponse as machineErrorResponse };

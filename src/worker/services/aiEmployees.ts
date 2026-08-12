import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { ApprovalError, consumeApprovalCard, requestApproval } from "./approvals";
import { MANAGING_PARTNER_NAMES } from "../../shared/registry/managingPartners";
import { AiRouteError } from "./aiRuns";

/**
 * AI employee lifecycle (P4, D10). The roster is seeded reference data (31 rows,
 * all INACTIVE). There is deliberately NO direct status-update route: the only
 * path to ACTIVE is request-activation (approval card for the reserved action
 * ai_employee.activate) → approved receipt → activate. ≤5 ACTIVE at any time —
 * a 6th activation is refused even with a valid approval. No silent activation.
 *
 * Tool scope: an employee can NEVER expand its own scope — grants are
 * HUMAN-only, enforced here at the service level.
 */

export const MAX_ACTIVE_AI_EMPLOYEES = 5;

export interface AIEmployeeRow {
  id: string;
  name: string;
  role: string;
  layer: string;
  primary_machines_json: string;
  status: string;
  purpose: string;
  prompt_version: string;
  tool_allowlist_json: string;
  data_scope_json: string;
  cost_policy_json: string;
  activated_by: string | null;
  activated_at: string | null;
  firm_scope: string;
  created_at: string;
}

function errorResponse(err: unknown): Response {
  if (err instanceof AiRouteError) return json({ error: err.code, detail: err.message }, { status: err.status });
  if (err instanceof ApprovalError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function getEmployee(env: Env, id: string): Promise<AIEmployeeRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM ai_employee WHERE id = ?1").bind(id).first<AIEmployeeRow>();
}

async function activeCount(env: Env, firmScope: string): Promise<number> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n FROM ai_employee WHERE status = 'ACTIVE' AND firm_scope = ?1",
  )
    .bind(firmScope)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Apply an activation behind an approved receipt for ai_employee.activate on this
 * exact employee. Refuses (without consuming the receipt) when the employee is
 * already ACTIVE or the ≤5 ACTIVE cap is reached (D10).
 */
export async function activateAiEmployee(
  env: Env,
  actor: Actor,
  employeeId: string,
  receiptId: string | undefined,
  reason: string,
): Promise<AIEmployeeRow> {
  const employee = await getEmployee(env, employeeId);
  if (!employee) throw new AiRouteError(404, "not_found");

  // Defense in depth (D10/ADR-003): a Managing Partner name may never be an
  // active AI employee, regardless of how the row got there.
  if (MANAGING_PARTNER_NAMES.some((mp) => employee.name.toLowerCase() === mp.toLowerCase())) {
    throw new AiRouteError(409, "mp_name_forbidden", "a Managing Partner name may never be an AI employee");
  }

  const authz = await authorize(
    env,
    actor,
    "ai_employee.activate",
    { objectType: "ai_employee", objectId: employee.id, firmScope: employee.firm_scope },
    { receiptId },
  );
  if (authz.decision === "DENY") throw new AiRouteError(403, "forbidden", authz.reason);
  if (authz.decision !== "ALLOW") {
    throw new AiRouteError(409, "approval_required", `activation requires an approved ai_employee.activate receipt (${authz.reason})`);
  }

  if (employee.status === "ACTIVE") {
    throw new AiRouteError(409, "already_active", "employee is already ACTIVE");
  }
  const active = await activeCount(env, employee.firm_scope);
  if (active >= MAX_ACTIVE_AI_EMPLOYEES) {
    throw new AiRouteError(
      409,
      "active_cap_reached",
      `at most ${MAX_ACTIVE_AI_EMPLOYEES} AI employees may be ACTIVE (D10); currently ${active}`,
    );
  }

  const activatedAt = new Date().toISOString();
  await env.WP_OS_DB.prepare(
    "UPDATE ai_employee SET status = 'ACTIVE', activated_by = ?2, activated_at = ?3 WHERE id = ?1",
  )
    .bind(employee.id, actor.firmUserId!, activatedAt)
    .run();

  await env.WP_OS_DB.prepare(
    `INSERT INTO ai_employee_status_history
       (id, ai_employee_id, from_status, to_status, actor_type, actor_id, reason, approval_receipt_id, firm_scope)
     VALUES (?1, ?2, ?3, 'ACTIVE', ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      `aish_${crypto.randomUUID()}`,
      employee.id,
      employee.status,
      actor.type,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      reason,
      receiptId!,
      employee.firm_scope,
    )
    .run();

  await consumeApprovalCard(env, receiptId!, { actorId: actor.firmUserId! });

  await appendEvent(env, {
    eventType: "ai_employee.activated",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_employee",
    objectId: employee.id,
    firmScope: employee.firm_scope,
    payload: { name: employee.name, from_status: employee.status, approval_receipt_id: receiptId },
  });

  return (await getEmployee(env, employee.id))!;
}

/**
 * Grant a tool to an AI employee. HUMAN-only: an AI employee can never expand
 * its own scope (or any scope) — enforced here, not by route auth alone.
 */
export async function grantToolScope(env: Env, actor: Actor, employeeId: string, toolKey: string): Promise<void> {
  if (actor.type !== "HUMAN") {
    throw new AiRouteError(403, "forbidden", "an AI employee can never grant tool scope");
  }
  const employee = await getEmployee(env, employeeId);
  if (!employee) throw new AiRouteError(404, "not_found");

  const authz = await authorize(env, actor, "ai_employee.tool_scope.grant", {
    objectType: "ai_employee",
    objectId: employee.id,
    firmScope: employee.firm_scope,
  });
  if (authz.decision === "DENY") throw new AiRouteError(403, "forbidden", authz.reason);

  await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO ai_employee_tool_scope (id, ai_employee_id, tool_key, granted_by, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(`aits_${crypto.randomUUID()}`, employee.id, toolKey, actor.firmUserId!, employee.firm_scope)
    .run();

  await appendEvent(env, {
    eventType: "ai_employee.tool_scope_granted",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_employee",
    objectId: employee.id,
    firmScope: employee.firm_scope,
    payload: { tool_key: toolKey },
  });
}

// ── HTTP handlers ──

export async function handleListAiEmployees(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM ai_employee ORDER BY rowid").all<AIEmployeeRow>();
  const employees = rows.results ?? [];
  return json({
    employees,
    active_count: employees.filter((e) => e.status === "ACTIVE").length,
    max_active: MAX_ACTIVE_AI_EMPLOYEES,
  });
}

export async function handleGetAiEmployee(ctx: RouteContext): Promise<Response> {
  const employee = await getEmployee(ctx.env, ctx.params.id!);
  if (!employee) return json({ error: "not_found" }, { status: 404 });
  const history = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM ai_employee_status_history WHERE ai_employee_id = ?1 ORDER BY created_at, id",
  )
    .bind(employee.id)
    .all();
  const tools = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM ai_employee_tool_scope WHERE ai_employee_id = ?1 ORDER BY created_at, id",
  )
    .bind(employee.id)
    .all();
  return json({ ...employee, status_history: history.results ?? [], tool_scope: tools.results ?? [] });
}

const requestActivationSchema = z.object({
  reason: z.string().trim().min(1).optional(),
});

export async function handleRequestActivation(ctx: RouteContext): Promise<Response> {
  const employee = await getEmployee(ctx.env, ctx.params.id!);
  if (!employee) return json({ error: "not_found" }, { status: 404 });
  if (employee.status === "ACTIVE") {
    return json({ error: "already_active", detail: "employee is already ACTIVE" }, { status: 409 });
  }
  let reason: string | undefined;
  const body = await ctx.request.json().catch(() => null);
  if (body !== null) {
    const parsed = requestActivationSchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
    reason = parsed.data.reason;
  }
  try {
    const card = await requestApproval(ctx.env, actorFromIdentity(ctx.identity!), {
      action_key: "ai_employee.activate",
      object_type: "ai_employee",
      object_id: employee.id,
      title: `Activate AI employee: ${employee.name} (${employee.role})`,
      summary: reason,
      payload: { employee_id: employee.id, name: employee.name, reason: reason ?? null },
      submit: true,
    });
    return json(card, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const activateSchema = z.object({
  approval_receipt_id: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
});

export async function handleActivateAiEmployee(ctx: RouteContext): Promise<Response> {
  const body = await ctx.request.json().catch(() => null);
  const parsed = activateSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const employee = await activateAiEmployee(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      ctx.params.id!,
      parsed.data.approval_receipt_id,
      parsed.data.reason ?? "activation approved",
    );
    return json(employee);
  } catch (err) {
    return errorResponse(err);
  }
}

const grantToolSchema = z.object({
  tool_key: z.string().trim().min(1),
});

export async function handleGrantToolScope(ctx: RouteContext): Promise<Response> {
  const body = await ctx.request.json().catch(() => null);
  const parsed = grantToolSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    await grantToolScope(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id!, parsed.data.tool_key);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

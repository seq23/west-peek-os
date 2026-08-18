import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { ApprovalError, consumeApprovalCard, requestApproval } from "./approvals";
import { MANAGING_PARTNER_NAMES } from "../../shared/registry/managingPartners";
import { AI_EMPLOYEE_ROSTER } from "../../shared/registry/aiEmployees";
import { resolveDuty } from "../../shared/workforce/dutyRoster";
import { AiRouteError } from "./aiRuns";

/**
 * AI employee lifecycle (P4, D10). The roster is seeded reference data, all INACTIVE at first.
 * The only path to ACTIVE for an employee that has never worked is request-activation (approval
 * card for the reserved action ai_employee.activate) → approved receipt → activate. No employee
 * ever starts acting without a human having said so at least once.
 *
 * THE CAP USED TO BE FIVE, AND CONFLATED TWO DIFFERENT QUESTIONS.
 *
 * D10 capped ACTIVE employees at five. Since only an ACTIVE employee can be seated in a meeting or
 * do work, that also capped how much of the workforce existed at all — the operator could reach
 * four of thirty-one, and consolidating the roster would not have changed that by one. The cap was
 * the real constraint, not the roster size.
 *
 * The two questions are now separate:
 *
 *   ACTIVE          — is this employee employed and available? All of them may be. Turning one on
 *                     or off is a toggle, not a negotiation.
 *   ON DUTY         — who is the firm leaning on right now? Still deliberately small (see
 *                     FOCUS_TEAM_SIZE), because attention is the scarce thing, not headcount.
 *
 * What the old cap was protecting — that the firm is not quietly running thirty autonomous
 * processes — is protected better by the duty roster and by the budget ceiling in runAi, both of
 * which bound WORK rather than EXISTENCE. A paused employee costs nothing; an unbounded one costs
 * money, and that is governed where the money is spent.
 *
 * Tool scope: an employee can NEVER expand its own scope — grants are HUMAN-only, enforced here at
 * the service level.
 */

/**
 * How many employees may be ACTIVE at once. Set to the whole roster: everyone can be on.
 * Derived rather than a literal so it cannot drift as the roster changes.
 */
export const MAX_ACTIVE_AI_EMPLOYEES = AI_EMPLOYEE_ROSTER.length;

/**
 * How many employees are ON DUTY at a time — the "most important five".
 *
 * Deliberately still five. The reason is not cost and never was: it is that a partner who is being
 * helped by thirty people at once is being helped by nobody, and a shortlist is only useful while
 * it is short. The roster rotates through this window by time of day rather than growing it.
 */
export const FOCUS_TEAM_SIZE = 5;

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
 * Apply an activation behind an approved receipt for ai_employee.activate on this exact employee.
 * Refuses (without consuming the receipt) when the employee is already ACTIVE or the cap is
 * reached. This is FIRST employment — the governed door. Day-to-day on and off is
 * setEmployeeRunning below, which needs no approval to pause and no new one to resume.
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
 * Turn an employee off, or back on again.
 *
 * ASYMMETRIC ON PURPOSE, and the asymmetry is the whole design.
 *
 * PAUSING needs no approval at all. Stopping a machine is always safe, and a control that is
 * awkward to reach is a control nobody uses in the moment they need it. There was previously no
 * way to deactivate an employee by any route — you could switch one on and never off — which is
 * the wrong half to have built first.
 *
 * RESUMING is free only for an employee a human has ALREADY approved once, which is what
 * `activated_at` records. The first activation still goes through the reserved action and its
 * approval card. So the guarantee D10 was really protecting survives — no employee ever acts
 * without a human having said so — while day-to-day on/off stays a toggle rather than a
 * negotiation. An employee that has never been approved cannot be resumed into service through
 * this door; it gets sent back to request-activation.
 *
 * HUMAN-only in both directions: an AI employee may not pause a colleague, and may certainly not
 * resume itself.
 */
export async function setEmployeeRunning(
  env: Env,
  actor: Actor,
  employeeId: string,
  running: boolean,
  reason: string,
): Promise<AIEmployeeRow> {
  if (actor.type !== "HUMAN") {
    throw new AiRouteError(403, "forbidden", "an AI employee can never pause or resume an employee");
  }
  const employee = await getEmployee(env, employeeId);
  if (!employee) throw new AiRouteError(404, "not_found");

  const to = running ? "ACTIVE" : "PAUSED";
  if (employee.status === to) {
    throw new AiRouteError(409, "no_change", `employee is already ${to}`);
  }

  if (running) {
    // Never approved, so there is nothing to resume — this is a first activation wearing a
    // different name, and it goes through the approval path like any other.
    if (!employee.activated_at) {
      throw new AiRouteError(
        409,
        "never_activated",
        "this employee has never been activated, so there is nothing to resume; request activation first",
      );
    }
    if (employee.status !== "PAUSED") {
      throw new AiRouteError(
        409,
        "not_paused",
        `only a PAUSED employee can be resumed; this one is ${employee.status}`,
      );
    }
    // RESTRICTED and RETIRED are deliberately excluded above: both are decisions someone made
    // about this employee, and a toggle must not quietly undo one.
    const active = await activeCount(env, employee.firm_scope);
    if (active >= MAX_ACTIVE_AI_EMPLOYEES) {
      throw new AiRouteError(
        409,
        "active_cap_reached",
        `at most ${MAX_ACTIVE_AI_EMPLOYEES} AI employees may be ACTIVE; currently ${active}`,
      );
    }
  } else if (employee.status !== "ACTIVE") {
    throw new AiRouteError(409, "not_active", `only an ACTIVE employee can be paused; this one is ${employee.status}`);
  }

  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = ?2 WHERE id = ?1").bind(employee.id, to).run();

  await env.WP_OS_DB.prepare(
    `INSERT INTO ai_employee_status_history
       (id, ai_employee_id, from_status, to_status, actor_type, actor_id, reason, approval_receipt_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)`,
  )
    .bind(
      `aish_${crypto.randomUUID()}`,
      employee.id,
      employee.status,
      to,
      actor.type,
      actor.firmUserId ?? "system",
      reason,
      employee.firm_scope,
    )
    .run();

  await appendEvent(env, {
    eventType: running ? "ai_employee.resumed" : "ai_employee.paused",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_employee",
    objectId: employee.id,
    firmScope: employee.firm_scope,
    payload: { name: employee.name, from_status: employee.status, to_status: to, reason },
  });

  return (await getEmployee(env, employee.id))!;
}

const runningSchema = z.object({
  running: z.boolean(),
  reason: z.string().trim().min(1).default("operator toggle"),
});

export async function handleSetEmployeeRunning(ctx: RouteContext): Promise<Response> {
  let body: unknown = null;
  try {
    body = await ctx.request.json();
  } catch {
    body = {};
  }
  const parsed = runningSchema.safeParse(body ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(
      await setEmployeeRunning(
        ctx.env,
        actorFromIdentity(ctx.identity!),
        ctx.params.id!,
        parsed.data.running,
        parsed.data.reason,
      ),
    );
  } catch (err) {
    return errorResponse(err);
  }
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

/**
 * Who is on duty, right now — the "most important five", chosen by the hour rather than by a model.
 *
 * The rota itself is pure (`shared/workforce/dutyRoster.ts`). This adds the only two facts it
 * cannot know: which employees are actually ACTIVE, and who the operator has pinned. Passing the
 * available set matters — a rota that names someone who is switched off is promising help that
 * will not arrive.
 *
 * The hour comes from the request rather than the server clock, because a Worker runs in UTC and
 * the partner does not. `?hour=` is the caller's local hour; without it, UTC is used and the
 * response says so, so a surprising roster is explainable rather than mysterious.
 */
export async function handleDutyRoster(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const raw = url.searchParams.get("hour");
  const parsedHour = raw === null ? null : Number(raw);
  const usingLocal = parsedHour !== null && Number.isFinite(parsedHour);
  const hour = usingLocal ? Math.trunc(parsedHour) : new Date().getUTCHours();

  const pinned = (url.searchParams.get("pinned") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const size = Number(url.searchParams.get("size") ?? FOCUS_TEAM_SIZE) || FOCUS_TEAM_SIZE;

  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT name, status FROM ai_employee WHERE firm_scope = ?1",
  )
    .bind("west-peek")
    .all<{ name: string; status: string }>();

  const all = rows.results ?? [];
  const available = all.filter((r) => r.status === "ACTIVE").map((r) => r.name);
  const roster = resolveDuty(hour, size, { available, pinned });

  return json({
    ...roster,
    hour,
    hour_source: usingLocal ? "caller" : "utc",
    active_count: available.length,
    roster_size: all.length,
    /** Stated so the screen never has to explain the rota in its own words. */
    how_it_works:
      "Everyone active stays available all day. This is who the firm is leaning on at this hour, " +
      "chosen by a fixed rota rather than by a model, so it is predictable and you can overrule it.",
  });
}
